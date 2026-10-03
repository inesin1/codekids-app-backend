import { ConfigService } from '@nestjs/config';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { DateTime } from 'luxon';
import {
  NotificationType,
  Role,
  TelegramLinkKind,
  TelegramRecipientKind,
} from '../../src/generated/client';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { TelegramNotifier } from '../../src/modules/common/telegram/telegram.notifier';
import {
  TelegramApiAdapter,
  TelegramOutboxEvent,
  TelegramService,
} from '../../src/modules/common/telegram/telegram.service';

describe('durable Telegram queue with PostgreSQL', () => {
  let prisma: PrismaService;
  let workerA: TelegramService;
  let workerB: TelegramService;
  let studentId: string;
  let userId: string;
  let updateId: bigint | undefined;
  let extraUserIds: string[];
  let extraCourseIds: string[];
  let extraEnrollmentIds: string[];
  let extraLessonIds: string[];

  beforeAll(async () => {
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return process.env['DATABASE_URL'];
        throw new Error(`Unexpected config key: ${key}`);
      },
      get: () => undefined,
    } as unknown as ConfigService;
    prisma = new PrismaService(config);
    await prisma.$connect();
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    studentId = `telegram-student-${suffix}`;
    userId = `telegram-user-${suffix}`;
    updateId = undefined;
    extraUserIds = [];
    extraCourseIds = [];
    extraEnrollmentIds = [];
    extraLessonIds = [];
    workerA = createService(prisma);
    workerB = createService(prisma);

    await prisma.user.create({
      data: {
        id: studentId,
        firstName: 'Queue',
        lastName: 'Student',
        studentProfile: { create: {} },
      },
    });
    await prisma.telegramGroup.create({
      data: {
        studentId,
        telegramChatId: `-100${suffix.replaceAll('-', '').slice(0, 10)}`,
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        firstName: 'Queue',
        lastName: 'User',
        telegramChatId: `10${suffix.replaceAll('-', '').slice(0, 10)}`,
        studentProfile: { create: {} },
      },
    });
  });

  afterEach(async () => {
    await prisma.telegramNotification.deleteMany({
      where: {
        type: {
          in: [
            NotificationType.BIRTHDAY_REMINDER_WEEK,
            NotificationType.BIRTHDAY_REMINDER_DAY,
            NotificationType.BIRTHDAY_REMINDER_TODAY,
          ],
        },
        entityId: { startsWith: `${studentId}:` },
      },
    });
    await prisma.lessonReport.deleteMany({
      where: { lessonId: { in: extraLessonIds } },
    });
    await prisma.lesson.deleteMany({ where: { id: { in: extraLessonIds } } });
    await prisma.enrollment.deleteMany({
      where: { id: { in: extraEnrollmentIds } },
    });
    await prisma.course.deleteMany({ where: { id: { in: extraCourseIds } } });
    await prisma.telegramNotification.deleteMany({
      where: { recipientId: { in: [studentId, userId] } },
    });
    if (updateId !== undefined) {
      await prisma.telegramUpdateInbox.deleteMany({ where: { updateId } });
    }
    await prisma.telegramLinkToken.deleteMany({
      where: { userId: { in: [studentId, userId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [studentId, userId, ...extraUserIds] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('deduplicates the same producer event across service instances and versions changed content', async () => {
    const event = groupEvent(
      studentId,
      'report-1',
      'occurrence-1',
      'report v1',
    );
    await Promise.all([workerA.enqueue(event), workerB.enqueue(event)]);

    const first = await findEvent(prisma, event);
    expect(first).toMatchObject({
      recipientKind: TelegramRecipientKind.GROUP,
      recipientId: studentId,
      desiredVersion: 1,
      deliveredVersion: 0,
    });
    expect(
      await prisma.telegramNotification.count({
        where: { eventKey: first.eventKey },
      }),
    ).toBe(1);

    await workerB.enqueue({ ...event, text: 'report v2' });

    const edited = await prisma.telegramNotification.findUniqueOrThrow({
      where: { eventKey: first.eventKey },
    });
    expect(edited.desiredVersion).toBe(2);
    expect(edited.text).toBe('report v2');
    expect(edited.deliveredVersion).toBe(0);
  });

  it('leases one row to one worker, recovers an expired lease, and ignores a stale acknowledgement', async () => {
    const event = groupEvent(studentId, 'report-2', 'occurrence-2', 'lease me');
    await workerA.enqueue(event);
    await findEvent(prisma, event);

    const [a, b] = await Promise.all([
      workerA.claimOutboxBatch(1),
      workerB.claimOutboxBatch(1),
    ]);
    expect(a.length + b.length).toBe(1);
    const firstClaim = a[0] ?? b[0];

    await prisma.telegramNotification.update({
      where: { id: firstClaim.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const secondClaim = (await workerB.claimOutboxBatch(1))[0];
    expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);

    const api = fakeApi({
      sendMessage: jest.fn().mockResolvedValue({ message_id: 102 }),
    });
    workerA.setApiAdapterForTesting(api);
    workerB.setApiAdapterForTesting(api);
    await workerA.deliverOutboxRow(firstClaim);

    let current = await prisma.telegramNotification.findUniqueOrThrow({
      where: { id: firstClaim.id },
    });
    expect(current.leaseToken).toBe(secondClaim.leaseToken);
    expect(current.deliveredVersion).toBe(0);
    expect(current.telegramMessageId).toBeNull();

    await workerB.deliverOutboxRow(secondClaim);
    current = await prisma.telegramNotification.findUniqueOrThrow({
      where: { id: firstClaim.id },
    });
    expect(current.deliveredVersion).toBe(1);
    expect(current.telegramMessageId).toBe(102);
  });

  it('recovers an outbox claim after its worker process stops', async () => {
    const event = groupEvent(
      studentId,
      'process-recovery',
      'process-recovery-occurrence',
      'recover after worker stop',
    );
    await workerA.enqueue(event);
    const queued = await findEvent(prisma, event);
    const firstWorkers = [spawnQueueWorker(), spawnQueueWorker()];
    const workers = [...firstWorkers];

    try {
      await Promise.all(
        firstWorkers.map((worker) => waitForWorkerMessage(worker, ['ready'])),
      );
      const claimResults = firstWorkers.map((worker) =>
        waitForWorkerMessage(worker, ['claimed', 'empty']),
      );
      for (const worker of firstWorkers) worker.send({ type: 'start' });

      const results = await Promise.all(claimResults);
      const claimedIndex = results.findIndex(({ type }) => type === 'claimed');
      expect(results.filter(({ type }) => type === 'claimed')).toHaveLength(1);
      expect(results.filter(({ type }) => type === 'empty')).toHaveLength(1);

      const firstWorker = firstWorkers[claimedIndex];
      if (!firstWorker) throw new Error('No worker claimed the queued event');
      const firstClaim = await prisma.telegramNotification.findUniqueOrThrow({
        where: { id: queued.id },
      });
      expect(firstClaim.leaseToken).toBeTruthy();
      await stopQueueWorker(firstWorker);

      await prisma.telegramNotification.update({
        where: { id: queued.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1000) },
      });

      const recoveryWorker = spawnQueueWorker();
      workers.push(recoveryWorker);
      await waitForWorkerMessage(recoveryWorker, ['ready']);
      const recoveredClaimMessage = waitForWorkerMessage(recoveryWorker, [
        'claimed',
        'empty',
      ]);
      recoveryWorker.send({ type: 'start' });
      const recoveredClaim = await recoveredClaimMessage;
      expect(recoveredClaim.type).toBe('claimed');
      if (recoveredClaim.type !== 'claimed') {
        throw new Error('Recovery worker did not reclaim the expired event');
      }
      const currentClaim = await prisma.telegramNotification.findUniqueOrThrow({
        where: { id: queued.id },
      });
      expect(currentClaim.leaseToken).not.toBe(firstClaim.leaseToken);
      expect(currentClaim.deliveredVersion).toBe(0);

      const delivered = waitForWorkerMessage(recoveryWorker, ['delivered']);
      recoveryWorker.send({ type: 'deliver' });
      await delivered;
      await waitForQueueWorkerExit(recoveryWorker);

      await expect(
        prisma.telegramNotification.findUniqueOrThrow({
          where: { id: queued.id },
        }),
      ).resolves.toMatchObject({
        deliveredVersion: 1,
        telegramMessageId: 901,
        leaseToken: null,
      });
    } finally {
      await Promise.all(workers.map(stopQueueWorker));
    }
  }, 30_000);

  it('preserves an edit made while the first API send is blocked and edits that message on retry', async () => {
    const teacherId = `telegram-teacher-${randomUUID()}`;
    extraUserIds.push(teacherId);
    const courseName = `Telegram Queue ${randomUUID()}`;
    const enrollmentId = `telegram-enrollment-${randomUUID()}`;
    const lessonId = `telegram-lesson-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: teacherId,
        firstName: 'Queue',
        lastName: 'Teacher',
        teacherProfile: { create: {} },
      },
    });
    const course = await prisma.course.create({ data: { name: courseName } });
    extraCourseIds.push(course.id);
    extraEnrollmentIds.push(enrollmentId);
    extraLessonIds.push(lessonId);
    await prisma.enrollment.create({
      data: {
        id: enrollmentId,
        teacherId,
        studentId,
        courseId: course.id,
        lessonPrice: '25.00',
        teacherRate: '12.00',
      },
    });
    await prisma.lesson.create({
      data: {
        id: lessonId,
        enrollmentId,
        teacherId,
        studentId,
        scheduledAt: new Date(),
        status: 'COMPLETED',
      },
    });
    const report = await prisma.lessonReport.create({
      data: {
        lessonId,
        topic: 'Telegram queue test',
        covered: 'First version',
        results: 'Synthetic results',
      },
    });
    const event = groupEvent(studentId, report.id, 'occurrence-3', 'old text');
    await workerA.enqueue(event);
    const initial = await findEvent(prisma, event);
    const claimed = (await workerA.claimOutboxBatch(1))[0];

    let releaseSend!: () => void;
    let signalSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      signalSend = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const api = fakeApi({
      sendMessage: jest.fn(async () => {
        signalSend();
        await sendGate;
        return { message_id: 203 } as never;
      }),
    });
    workerA.setApiAdapterForTesting(api);
    workerB.setApiAdapterForTesting(api);

    const firstDelivery = workerA.deliverOutboxRow(claimed);
    try {
      await sendStarted;
      await workerB.enqueue({ ...event, text: 'new text while send runs' });
    } finally {
      releaseSend();
    }
    await firstDelivery;

    const afterFirstSend = await prisma.telegramNotification.findUniqueOrThrow({
      where: { id: initial.id },
    });
    expect(afterFirstSend).toMatchObject({
      telegramMessageId: 203,
      desiredVersion: 2,
      deliveredVersion: 0,
      sentAt: null,
    });
    await expect(
      prisma.lessonReport.findUniqueOrThrow({ where: { id: report.id } }),
    ).resolves.toMatchObject({ sentToTelegram: false });

    const editedClaim = (await workerB.claimOutboxBatch(1))[0];
    expect(editedClaim.leaseVersion).toBe(2);
    await workerB.deliverOutboxRow(editedClaim);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalledWith(
      afterFirstSend.chatId,
      203,
      'new text while send runs',
      expect.any(Object),
    );
    const delivered = await prisma.telegramNotification.findUniqueOrThrow({
      where: { id: initial.id },
    });
    expect(delivered).toMatchObject({
      telegramMessageId: 203,
      desiredVersion: 2,
      deliveredVersion: 2,
    });
    expect(delivered.sentAt).not.toBeNull();
    await expect(
      prisma.lessonReport.findUniqueOrThrow({ where: { id: report.id } }),
    ).resolves.toMatchObject({ sentToTelegram: true });
  });

  it('does not send a claimed message to the old recipient after unlink and rebind', async () => {
    const event = groupEvent(
      studentId,
      'report-4',
      'occurrence-4',
      'current binding only',
    );
    await workerA.enqueue(event);
    const row = await findEvent(prisma, event);
    const claimed = (await workerA.claimOutboxBatch(1))[0];

    await workerB.unlinkGroup(studentId);
    await prisma.telegramGroup.update({
      where: { studentId },
      data: {
        telegramChatId: '-200987654',
        isActive: true,
        bindingVersion: { increment: 1 },
      },
    });
    const api = fakeApi();
    workerA.setApiAdapterForTesting(api);
    await workerA.deliverOutboxRow(claimed);

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.editMessageText).not.toHaveBeenCalled();
    const canceled = await prisma.telegramNotification.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(canceled.canceledAt).not.toBeNull();

    await workerB.enqueue({ ...event, occurrenceKey: 'occurrence-4-rebound' });
    const rebound = await findEvent(prisma, {
      ...event,
      occurrenceKey: 'occurrence-4-rebound',
    });
    expect(rebound.chatId).toBe('-200987654');
  });

  it('persists webhook updates once and propagates inbox database failures', async () => {
    const update = makeUpdate(800001);
    updateId = BigInt(update.update_id);
    await workerA.acceptWebhookUpdate(update);
    await workerB.acceptWebhookUpdate({
      ...update,
      message: undefined,
    } as Update);

    const row = await prisma.telegramUpdateInbox.findUniqueOrThrow({
      where: { updateId },
    });
    const payload = row.payload as unknown as Update;
    expect(payload.update_id).toBe(800001);
    expect(payload.message).toBeDefined();
    expect(
      await prisma.telegramUpdateInbox.count({ where: { updateId } }),
    ).toBe(1);

    const createMany = jest
      .spyOn(prisma.telegramUpdateInbox, 'createMany')
      .mockRejectedValueOnce(new Error('synthetic database outage'));
    await expect(
      workerA.acceptWebhookUpdate(makeUpdate(800002)),
    ).rejects.toThrow('synthetic database outage');
    createMany.mockRestore();
  });

  it('claims inbox work exclusively and retries a failed update until it is processed', async () => {
    const update = makeUpdate(800003);
    updateId = BigInt(update.update_id);
    await workerA.acceptWebhookUpdate(update);

    const [a, b] = await Promise.all([
      workerA.claimInboxBatch(1),
      workerB.claimInboxBatch(1),
    ]);
    expect(a.length + b.length).toBe(1);
    const firstClaim = a[0] ?? b[0];
    let processAttempt = 0;
    const fakeBot = {
      isInited: () => true,
      handleUpdate: jest.fn(() => {
        processAttempt += 1;
        if (processAttempt === 1)
          return Promise.reject(new Error('temporary callback failure'));
        return Promise.resolve();
      }),
    };
    setBotForInbox(workerA, fakeBot);
    await workerA.processInboxRow(firstClaim);

    let current = await prisma.telegramUpdateInbox.findUniqueOrThrow({
      where: { updateId },
    });
    expect(current).toMatchObject({
      attempts: 1,
      processedAt: null,
      leaseToken: null,
    });
    expect(current.error).toBe('telegram_network_error');

    await prisma.telegramUpdateInbox.update({
      where: { updateId },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const retryClaim = (await workerB.claimInboxBatch(1))[0];
    const secondBot = {
      isInited: () => true,
      handleUpdate: jest.fn().mockResolvedValue(undefined),
    };
    setBotForInbox(workerB, secondBot);
    await workerB.processInboxRow(retryClaim);

    current = await prisma.telegramUpdateInbox.findUniqueOrThrow({
      where: { updateId },
    });
    expect(current.attempts).toBe(2);
    expect(current.processedAt).not.toBeNull();
    expect(current.error).toBeNull();
  });

  it('atomically consumes a deep-link token when two starts race', async () => {
    const token = `link-${randomUUID()}`;
    await prisma.telegramLinkToken.create({
      data: {
        token,
        kind: TelegramLinkKind.PRIVATE,
        userId,
        bindingVersion: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const repliesA: string[] = [];
    const repliesB: string[] = [];
    const ctxA = makeStartContext(token, 99001, repliesA);
    const ctxB = makeStartContext(token, 99002, repliesB);
    const onStart = getPrivateMethod<(ctx: unknown) => Promise<void>>(
      workerA,
      'onStart',
    );
    const start = (ctx: unknown): Promise<void> =>
      onStart.call(workerA, ctx) as Promise<void>;

    await Promise.all([start(ctxA), start(ctxB)]);

    const linked = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      omit: { securityVersion: false },
    });
    expect(['99001', '99002']).toContain(linked.telegramChatId);
    expect(linked.telegramBindingVersion).toBe(1);
    expect(await prisma.telegramLinkToken.count({ where: { token } })).toBe(0);
    expect(repliesA.length + repliesB.length).toBe(1);
  });

  it('serializes group-link creation with unlink and rejects the stale link', async () => {
    await prisma.telegramGroup.deleteMany({ where: { studentId } });
    Object.defineProperty(workerA, 'bot', {
      configurable: true,
      value: { isInited: () => true, botInfo: { username: 'queue_test_bot' } },
    });

    let releaseUserLock!: () => void;
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });
    const releaseLock = new Promise<void>((resolve) => {
      releaseUserLock = resolve;
    });
    const lockTransaction = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${studentId} FOR UPDATE`;
      signalLockHeld();
      await releaseLock;
    });
    await lockHeld;

    let createLink: Promise<{ url: string }> | undefined;
    let unlink: Promise<void> | undefined;
    try {
      createLink = workerA.createGroupLink(studentId);
      await waitForBlockedQuery(
        prisma,
        '%SELECT "id" FROM "users"%FOR UPDATE%',
        1,
      );
      unlink = workerB.unlinkGroup(studentId);
      await waitForBlockedQuery(
        prisma,
        '%SELECT "id" FROM "users"%FOR UPDATE%',
        2,
      );
    } finally {
      releaseUserLock();
      await lockTransaction;
    }

    const [linkResult] = await Promise.all([createLink, unlink]);
    const { url } = linkResult;
    const token = new URL(url).searchParams.get('startgroup');
    expect(token).toBeTruthy();

    const unlinked = await prisma.telegramGroup.findUniqueOrThrow({
      where: { studentId },
    });
    expect(unlinked).toMatchObject({
      telegramChatId: null,
      isActive: false,
      bindingVersion: 1,
    });
    expect(
      await prisma.telegramLinkToken.count({ where: { token: token! } }),
    ).toBe(0);

    const replies: string[] = [];
    const onStart = getPrivateMethod<(ctx: unknown) => Promise<void>>(
      workerA,
      'onStart',
    );
    const staleGroupStart = (ctx: unknown): Promise<void> =>
      onStart.call(workerA, ctx) as Promise<void>;
    await staleGroupStart({
      match: token,
      chat: { id: -99003, type: 'supergroup' },
      reply: (message: string) => {
        replies.push(message);
        return Promise.resolve();
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/недействительна|устарела/i);
    await expect(
      prisma.telegramGroup.findUniqueOrThrow({ where: { studentId } }),
    ).resolves.toMatchObject({ telegramChatId: null, bindingVersion: 1 });
  });

  it('recovers a partially completed birthday fanout without duplicating recipients', async () => {
    const staffIds = [
      `telegram-staff-${randomUUID()}`,
      `telegram-staff-${randomUUID()}`,
    ];
    const today = DateTime.now().setZone('Europe/Moscow');
    await prisma.user.update({
      where: { id: studentId },
      data: {
        birthDate: new Date(
          Date.UTC(today.year - 20, today.month - 1, today.day),
        ),
      },
    });
    await prisma.user.createMany({
      data: staffIds.map((id, index) => ({
        id,
        firstName: `Staff${index}`,
        lastName: 'Queue',
        telegramChatId: `20${randomUUID().replaceAll('-', '').slice(0, 10)}`,
        staffRoles: [index === 0 ? Role.ADMIN : Role.MANAGER],
      })),
    });

    const notifier = new TelegramNotifier(prisma, workerA, {
      get: () => undefined,
    } as unknown as ConfigService);
    const realEnqueue = workerA.enqueue.bind(
      workerA,
    ) as unknown as typeof workerA.enqueue;
    let enqueuedBeforeFailure = 0;
    let firstEnqueuedType: NotificationType | undefined;
    const enqueueSpy = jest
      .spyOn(workerA, 'enqueue')
      .mockImplementation((event, tx) => {
        if (!staffIds.includes(event.recipient.id))
          return realEnqueue(event, tx);
        if (tx) return realEnqueue(event, tx);
        firstEnqueuedType ??= event.type;
        if (enqueuedBeforeFailure++ === 1)
          return Promise.reject(new Error('synthetic partial fanout failure'));
        return realEnqueue(event, tx);
      });

    try {
      await expect(notifier.sendBirthdayReminders()).rejects.toThrow(
        'synthetic partial fanout failure',
      );
      const afterFailure = await prisma.telegramNotification.findMany({
        where: {
          recipientKind: TelegramRecipientKind.USER,
          recipientId: { in: staffIds },
        },
      });
      expect(afterFailure).toHaveLength(1);
      expect(afterFailure[0].type).toBe(firstEnqueuedType);
      expect(firstEnqueuedType).toBe(NotificationType.BIRTHDAY_REMINDER_TODAY);

      enqueueSpy.mockImplementation(realEnqueue);
      await notifier.sendBirthdayReminders();

      const afterRetry = await prisma.telegramNotification.findMany({
        where: {
          recipientKind: TelegramRecipientKind.USER,
          recipientId: { in: staffIds },
        },
      });
      const eventTypes = new Set(afterRetry.map(({ type }) => type));
      expect(afterRetry).toHaveLength(staffIds.length * eventTypes.size);
      for (const type of eventTypes) {
        expect(
          new Set(
            afterRetry
              .filter((notification) => notification.type === type)
              .map(({ recipientId }) => recipientId),
          ),
        ).toEqual(new Set(staffIds));
      }
    } finally {
      enqueueSpy.mockRestore();
      await prisma.telegramNotification.deleteMany({
        where: { recipientId: { in: staffIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: staffIds } } });
    }
  });

  it.each([
    ['network', new Error('connection reset'), 'telegram_network_error', false],
    [
      '429',
      telegramError(429, 'Too Many Requests', 4),
      'telegram_api_429',
      false,
    ],
    ['permanent', telegramError(400, 'Bad Request'), 'telegram_api_400', true],
  ])(
    'records %s delivery failure with its retry policy',
    async (_name, failure, code, terminal) => {
      const event = groupEvent(
        studentId,
        `failure-${_name}`,
        `failure-occurrence-${_name}`,
        'fail once',
      );
      await workerA.enqueue(event);
      const row = await findEvent(prisma, event);
      const claimed = (await workerA.claimOutboxBatch(1))[0];
      expect(claimed.id).toBe(row.id);
      const api = fakeApi({
        sendMessage: jest.fn().mockRejectedValue(failure),
      });
      workerA.setApiAdapterForTesting(api);
      const before = Date.now();

      await workerA.deliverOutboxRow(claimed);

      const current = await prisma.telegramNotification.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(current.error).toBe(code);
      expect(Boolean(current.failedAt)).toBe(terminal);
      expect(current.leaseToken).toBeNull();
      if (_name === '429') {
        expect(current.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(
          3500,
        );
      } else if (!terminal) {
        expect(current.nextAttemptAt.getTime()).toBeGreaterThan(before);
      }
      if (terminal) {
        expect(await workerB.claimOutboxBatch(1)).toHaveLength(0);
      }
    },
  );
});

type QueueWorkerMessage = {
  type: string;
  id?: string;
  error?: string;
};

function spawnQueueWorker() {
  const guard = resolve(process.cwd(), 'test/assert-integration-database.cjs');
  return fork(
    resolve(process.cwd(), 'test/integration/telegram-queue-worker.ts'),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env['NODE_OPTIONS'], `--require=${guard}`]
          .filter(Boolean)
          .join(' '),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
}

function waitForWorkerMessage(
  worker: ChildProcess,
  expectedTypes: string[],
): Promise<QueueWorkerMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      finish(() => rejectMessage(new Error('Worker IPC message timed out')));
    }, 15_000);
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      worker.off('error', onError);
      callback();
    };
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const message = value as QueueWorkerMessage;
      if (message.type === 'error') {
        finish(() =>
          rejectMessage(new Error(message.error ?? 'Worker process failed')),
        );
      } else if (expectedTypes.includes(message.type)) {
        finish(() => resolveMessage(message));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        rejectMessage(
          new Error(`Worker exited before its message (${code ?? signal})`),
        ),
      );
    };
    const onError = (error: Error) => {
      finish(() => rejectMessage(error));
    };
    worker.on('message', onMessage);
    worker.once('exit', onExit);
    worker.once('error', onError);
  });
}

function waitForQueueWorkerExit(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => worker.once('exit', () => resolveExit()));
}

function stopQueueWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 5_000);
    worker.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
    worker.kill('SIGKILL');
  });
}

function createService(prisma: PrismaService) {
  const service = new TelegramService(prisma, {
    get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined),
    getOrThrow: (key: string) => {
      if (key === 'DATABASE_URL') return process.env['DATABASE_URL'];
      throw new Error(`Unexpected config key: ${key}`);
    },
  } as ConfigService);
  service.setApiAdapterForTesting(fakeApi());
  return service;
}

function groupEvent(
  studentId: string,
  entityId: string,
  occurrenceKey: string,
  text: string,
): TelegramOutboxEvent {
  return {
    recipient: { kind: TelegramRecipientKind.GROUP, id: studentId },
    occurrenceKey,
    type: NotificationType.LESSON_REPORT,
    entityId,
    text,
  };
}

async function findEvent(prisma: PrismaService, event: TelegramOutboxEvent) {
  const recipient = event.recipient;
  const recipientVersion =
    recipient.kind === TelegramRecipientKind.GROUP
      ? (
          await prisma.telegramGroup.findUniqueOrThrow({
            where: { studentId: recipient.id },
          })
        ).bindingVersion
      : (
          await prisma.user.findUniqueOrThrow({
            where: { id: recipient.id },
            select: { telegramBindingVersion: true },
          })
        ).telegramBindingVersion;
  const rows = await prisma.telegramNotification.findMany({
    where: {
      recipientKind: recipient.kind,
      recipientId: recipient.id,
      occurrenceKey: event.occurrenceKey,
      bindingVersion: recipientVersion,
    },
  });
  expect(rows).toHaveLength(1);
  return rows[0];
}

function fakeApi(overrides: Partial<TelegramApiAdapter> = {}) {
  return {
    sendMessage: jest.fn().mockResolvedValue({ message_id: 101 }),
    editMessageText: jest.fn().mockResolvedValue(true),
    sendDocument: jest.fn().mockResolvedValue({ message_id: 101 }),
    editMessageCaption: jest.fn().mockResolvedValue(true),
    setWebhook: jest.fn().mockResolvedValue(true),
    getUpdates: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TelegramApiAdapter;
}

function makeUpdate(id: number): Update {
  return { update_id: id, message: { message_id: id } } as Update;
}

function setBotForInbox(service: TelegramService, bot: unknown) {
  Object.defineProperty(service, 'bot', { configurable: true, value: bot });
}

function makeStartContext(token: string, chatId: number, replies: string[]) {
  return {
    match: token,
    chat: { id: chatId, type: 'private' },
    reply: jest.fn((text: string) => {
      replies.push(text);
      return Promise.resolve();
    }),
  };
}

function getPrivateMethod<T>(instance: object, name: string): T {
  return Reflect.get(instance, name) as T;
}

function telegramError(code: number, description: string, retryAfter?: number) {
  return new GrammyError(
    'Telegram API request failed',
    {
      ok: false,
      error_code: code,
      description,
      ...(retryAfter !== undefined && {
        parameters: { retry_after: retryAfter },
      }),
    },
    'sendMessage',
    {},
  );
}

async function waitForBlockedQuery(
  prisma: PrismaService,
  queryPattern: string,
  minimumCount: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE ${queryPattern}
    `;
    if ((rows[0]?.count ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${minimumCount} blocked queries matching ${queryPattern}`,
  );
}
