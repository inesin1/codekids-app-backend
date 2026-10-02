import { ConfigService } from '@nestjs/config';
import { GrammyError } from 'grammy';
import {
  NotificationType,
  TelegramNotification,
  TelegramRecipientKind,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_ATTEMPTS,
  TelegramApiAdapter,
  TelegramService,
} from './telegram.service';

type AsyncMock = jest.Mock<Promise<unknown>, unknown[]>;
type MockPrisma = {
  $executeRaw: AsyncMock;
  $queryRaw: AsyncMock;
  $transaction: jest.Mock<
    Promise<unknown>,
    [callback: (tx: MockPrisma) => Promise<unknown>]
  >;
  telegramNotification: Record<
    | 'findUnique'
    | 'findMany'
    | 'findFirst'
    | 'count'
    | 'createMany'
    | 'update'
    | 'updateMany',
    AsyncMock
  >;
  telegramUpdateInbox: Record<
    'createMany' | 'findUnique' | 'update' | 'updateMany',
    AsyncMock
  >;
  user: Record<'findUnique' | 'updateMany', AsyncMock>;
  studentProfile: Record<'findUnique', AsyncMock>;
  material: Record<
    'findUnique' | 'findUniqueOrThrow' | 'updateMany',
    AsyncMock
  >;
  lessonReport: Record<'updateMany', AsyncMock>;
  lesson: Record<'findUnique', AsyncMock>;
  rescheduleRequest: Record<'updateMany', AsyncMock>;
  telegramGroup: Record<'findUnique' | 'updateMany' | 'upsert', AsyncMock>;
  telegramLinkToken: Record<'create' | 'deleteMany' | 'findUnique', AsyncMock>;
};

const mockAsync = (): AsyncMock => jest.fn<Promise<unknown>, unknown[]>();

const makeRow = (
  overrides: Partial<TelegramNotification> = {},
): TelegramNotification => ({
  id: 'n1',
  chatId: '-100',
  type: NotificationType.LESSON_REPORT,
  entityId: 'r1',
  eventKey: 'event',
  occurrenceKey: 'report',
  recipientKind: TelegramRecipientKind.GROUP,
  recipientId: 'student-1',
  bindingVersion: 1,
  payloadHash: 'hash',
  desiredVersion: 1,
  deliveredVersion: 0,
  leaseToken: 'lease',
  leaseVersion: 1,
  leaseExpiresAt: new Date('2026-10-02T12:00:00Z'),
  failedAt: null,
  canceledAt: null,
  text: 'текст',
  replyMarkup: null,
  telegramMessageId: null,
  sentAt: null,
  attempts: 1,
  error: null,
  nextAttemptAt: new Date('2026-10-02T10:00:00Z'),
  createdAt: new Date('2026-10-02T10:00:00Z'),
  updatedAt: new Date('2026-10-02T10:00:00Z'),
  ...overrides,
});

const apiError = (error_code: number, description: string) =>
  new GrammyError(
    description,
    { ok: false, error_code, description },
    'sendMessage',
    {},
  );

describe('TelegramService durable queues', () => {
  let service: TelegramService;
  let prisma: MockPrisma;
  let api: Record<string, jest.Mock>;

  beforeEach(() => {
    prisma = {
      $executeRaw: mockAsync().mockResolvedValue(1),
      $queryRaw: mockAsync().mockResolvedValue([]),
      $transaction: jest.fn(
        async (callback: (tx: MockPrisma) => Promise<unknown>) =>
          callback({ ...prisma }),
      ),
      telegramNotification: {
        findUnique: mockAsync(),
        findMany: mockAsync(),
        findFirst: mockAsync(),
        count: mockAsync(),
        createMany: mockAsync(),
        update: mockAsync(),
        updateMany: mockAsync().mockResolvedValue({ count: 1 }),
      },
      telegramUpdateInbox: {
        createMany: mockAsync(),
        findUnique: mockAsync(),
        update: mockAsync(),
        updateMany: mockAsync().mockResolvedValue({ count: 1 }),
      },
      user: { findUnique: mockAsync(), updateMany: mockAsync() },
      studentProfile: { findUnique: mockAsync() },
      material: {
        findUnique: mockAsync(),
        findUniqueOrThrow: mockAsync(),
        updateMany: mockAsync(),
      },
      lessonReport: { updateMany: mockAsync() },
      lesson: { findUnique: mockAsync() },
      rescheduleRequest: { updateMany: mockAsync() },
      telegramGroup: {
        findUnique: mockAsync(),
        updateMany: mockAsync(),
        upsert: mockAsync(),
      },
      telegramLinkToken: {
        create: mockAsync(),
        deleteMany: mockAsync(),
        findUnique: mockAsync(),
      },
    };
    service = new TelegramService(
      prisma as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'TELEGRAM_BOT_TOKEN' ? '123:test' : undefined,
      } as unknown as ConfigService,
    );
    api = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 42 }),
      editMessageText: jest.fn().mockResolvedValue(true),
      sendDocument: jest.fn().mockResolvedValue({ message_id: 43 }),
      editMessageCaption: jest.fn().mockResolvedValue(true),
      setWebhook: jest.fn(),
      getUpdates: jest.fn(),
    };
    service.setApiAdapterForTesting(api as unknown as TelegramApiAdapter);
  });

  it('persists a webhook update by its unique Telegram update id', async () => {
    const update = { update_id: 73, message: { message_id: 2 } };

    await service.acceptWebhookUpdate(update as never);

    expect(prisma.telegramUpdateInbox.createMany).toHaveBeenCalledWith({
      data: [{ updateId: 73n, payload: update }],
      skipDuplicates: true,
    });
  });

  it('creates group-link tokens under the same owner lock as unlink', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({
      user: { isActive: true },
      telegramGroup: { bindingVersion: 7 },
    });
    jest.spyOn(service.bot!, 'isInited').mockReturnValue(true);
    Object.defineProperty(service.bot, 'botInfo', {
      configurable: true,
      value: { username: 'codekids_bot' },
    });

    const link = await service.createGroupLink('student-1');
    expect(link.url).toContain('startgroup=');

    expect(
      (prisma.$queryRaw.mock.calls[0][0] as { sql: string }).sql,
    ).toContain('FROM "users" WHERE "id"');
    const [createArgs] = prisma.telegramLinkToken.create.mock.calls[0] as [
      { data: { kind: string; userId: string; bindingVersion: number } },
    ];
    expect(createArgs.data).toMatchObject({
      kind: 'GROUP',
      userId: 'student-1',
      bindingVersion: 7,
    });
  });

  it('creates private-link tokens while holding the user binding lock', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'teacher-1',
      isActive: true,
      staffRoles: [],
      teacherProfile: { userId: 'teacher-1' },
      studentProfile: null,
      telegramBindingVersion: 5,
    });
    jest.spyOn(service.bot!, 'isInited').mockReturnValue(true);
    Object.defineProperty(service.bot, 'botInfo', {
      configurable: true,
      value: { username: 'codekids_bot' },
    });

    await service.createUserLink('teacher-1');

    expect(
      (prisma.$queryRaw.mock.calls[0][0] as { sql: string }).sql,
    ).toContain('FROM "users" WHERE "id"');
    const [createArgs] = prisma.telegramLinkToken.create.mock.calls[0] as [
      { data: { kind: string; userId: string; bindingVersion: number } },
    ];
    expect(createArgs.data).toMatchObject({
      kind: 'PRIVATE',
      userId: 'teacher-1',
      bindingVersion: 5,
    });
  });

  it('retains a versioned inactive group tombstone when unlinked before first binding', async () => {
    prisma.studentProfile.findUnique.mockResolvedValue({ userId: 'student-1' });

    await service.unlinkGroup('student-1');

    const [upsertArgs] = prisma.telegramGroup.upsert.mock.calls[0] as [
      {
        where: { studentId: string };
        create: {
          studentId: string;
          telegramChatId: string | null;
          isActive: boolean;
          bindingVersion: number;
        };
      },
    ];
    expect(upsertArgs.where).toEqual({ studentId: 'student-1' });
    expect(upsertArgs.create).toEqual({
      studentId: 'student-1',
      telegramChatId: null,
      isActive: false,
      bindingVersion: 1,
    });
    expect(prisma.telegramLinkToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'student-1', kind: 'GROUP' },
    });
  });

  it('rejects malformed update ids instead of acknowledging them', async () => {
    await expect(
      service.acceptWebhookUpdate({
        update_id: Number.MAX_SAFE_INTEGER + 1,
      } as never),
    ).rejects.toThrow('Invalid Telegram update id');
    expect(prisma.telegramUpdateInbox.createMany).not.toHaveBeenCalled();
  });

  it('persists an owner-keyed event with hash-based identity and conditional payload updates', async () => {
    prisma.user.findUnique.mockResolvedValue({
      isActive: true,
      telegramChatId: 'private-chat',
      telegramBindingVersion: 4,
    });

    await service.enqueue({
      recipient: { kind: TelegramRecipientKind.USER, id: 'user-1' },
      occurrenceKey: 'daily:2026-10-02',
      type: NotificationType.STAFF_DIGEST,
      entityId: '2026-10-02',
      text: 'digest',
    });

    const query = prisma.$executeRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toContain('ON CONFLICT ("eventKey") DO UPDATE');
    expect(query.sql).toContain('IS DISTINCT FROM EXCLUDED."payloadHash"');
    expect(query.values).toContain('private-chat');
    expect(query.values).toContain(TelegramRecipientKind.USER);
  });

  it('claims rows using a lease and SKIP LOCKED', async () => {
    const row = makeRow({ leaseToken: 'new-lease' });
    prisma.$queryRaw.mockResolvedValue([{ id: 'n1' }]);
    prisma.telegramNotification.findUnique.mockResolvedValue(
      makeRow({ leaseToken: null, leaseVersion: null }),
    );
    prisma.telegramNotification.update.mockResolvedValue(row);

    const claimed = await service.claimOutboxBatch();

    expect(claimed).toEqual([row]);
    expect(
      (prisma.$queryRaw.mock.calls[0][0] as { sql: string }).sql,
    ).toContain('SKIP LOCKED');
    const [claimArgs] = prisma.telegramNotification.update.mock.calls[0] as [
      {
        data: {
          leaseToken: string;
          leaseVersion: number;
          leaseExpiresAt: Date;
          attempts: { increment: number };
        };
      },
    ];
    expect(typeof claimArgs.data.leaseToken).toBe('string');
    expect(claimArgs.data.leaseVersion).toBe(1);
    expect(claimArgs.data.leaseExpiresAt).toBeInstanceOf(Date);
    expect(claimArgs.data.attempts).toEqual({ increment: 1 });
  });

  it('delivers only to the current recipient binding and records message ids', async () => {
    const row = makeRow();
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    prisma.telegramNotification.findUnique.mockResolvedValue(row);

    await service.deliverOutboxRow(row);

    expect(api.sendMessage).toHaveBeenCalledWith(
      '-100',
      'текст',
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
    const [ackArgs] = prisma.telegramNotification.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(ackArgs.data.telegramMessageId).toBe(42);
    expect(ackArgs.data.deliveredVersion).toBe(1);
    expect(ackArgs.data.sentAt).toBeInstanceOf(Date);
  });

  it('cancels a claimed event whose recipient was rebound', async () => {
    const row = makeRow();
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-200',
        bindingVersion: 2,
      },
    });

    await service.deliverOutboxRow(row);

    expect(api.sendMessage).not.toHaveBeenCalled();
    const [cancelArgs] = prisma.telegramNotification.updateMany.mock
      .calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(cancelArgs.where).toMatchObject({
      id: 'n1',
      leaseToken: 'lease',
      leaseVersion: 1,
    });
    expect(cancelArgs.data.canceledAt).toBeInstanceOf(Date);
  });

  it('retains the sent message id when the desired payload changes during delivery', async () => {
    const row = makeRow();
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    prisma.telegramNotification.findUnique.mockResolvedValue({
      ...row,
      desiredVersion: 2,
    });

    await service.deliverOutboxRow(row);

    const [update] = prisma.telegramNotification.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(update.data).toMatchObject({
      telegramMessageId: 42,
      sentAt: null,
      leaseToken: null,
    });
    expect(update.data).not.toHaveProperty('deliveredVersion');
  });

  it('commits entity sent state with the current-version delivery acknowledgement', async () => {
    const row = makeRow();
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'r1' }])
      .mockResolvedValueOnce([]);
    prisma.telegramNotification.findUnique.mockResolvedValue(row);

    await service.deliverOutboxRow(row);

    const queries = prisma.$queryRaw.mock.calls.map(
      ([query]) => (query as { sql: string }).sql,
    );
    expect(queries[0]).toContain('"lesson_reports"');
    expect(queries[1]).toContain('"telegram_notifications"');
    expect(prisma.lessonReport.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { sentToTelegram: true },
    });
  });

  it('cancels lesson reminders after the lesson time or state changes', async () => {
    const row = makeRow({
      type: NotificationType.LESSON_REMINDER_SOON,
      occurrenceKey: '2026-10-02T12:00:00.000Z',
    });
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    prisma.lesson.findUnique.mockResolvedValue({
      status: 'CANCELED',
      scheduledAt: new Date(row.occurrenceKey),
    });

    await service.deliverOutboxRow(row);

    expect(api.sendMessage).not.toHaveBeenCalled();
    const [cancelArgs] = prisma.telegramNotification.updateMany.mock
      .calls[0] as [{ data: Record<string, unknown> }];
    expect(cancelArgs.data.canceledAt).toBeInstanceOf(Date);
  });

  it('stores sanitized terminal API errors and stops retrying', async () => {
    const row = makeRow({ attempts: MAX_ATTEMPTS });
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    api.sendMessage.mockRejectedValue(
      apiError(400, 'Bad Request with private chat details'),
    );

    await service.deliverOutboxRow(row);

    const [failureArgs] = prisma.telegramNotification.updateMany.mock
      .calls[0] as [{ data: Record<string, unknown> }];
    expect(failureArgs.data.failedAt).toBeInstanceOf(Date);
    expect(failureArgs.data.error).toBe('telegram_api_400');
  });

  it('honors Telegram 429 retry_after without logging the raw error', async () => {
    const row = makeRow({ attempts: 2 });
    prisma.user.findUnique.mockResolvedValue({ isActive: true });
    prisma.studentProfile.findUnique.mockResolvedValue({
      telegramGroup: {
        isActive: true,
        telegramChatId: '-100',
        bindingVersion: 1,
      },
    });
    api.sendMessage.mockRejectedValue(
      new GrammyError(
        'sensitive response',
        {
          ok: false,
          error_code: 429,
          description: 'sensitive response',
          parameters: { retry_after: 13 },
        },
        'sendMessage',
        {},
      ),
    );

    await service.deliverOutboxRow(row);

    const [args] = prisma.telegramNotification.updateMany.mock.calls[0] as [
      { data: { nextAttemptAt: Date; error: string } },
    ];
    expect(
      Math.abs(args.data.nextAttemptAt.getTime() - Date.now() - 13_000),
    ).toBeLessThan(100);
    expect(args.data.error).toBe('telegram_api_429');
  });

  it('leases and processes durable inbox rows', async () => {
    const row = {
      updateId: 9n,
      payload: { update_id: 9 },
      leaseToken: 'inbox-lease',
      attempts: 1,
    };
    prisma.$queryRaw.mockResolvedValue([{ updateId: 9n }]);
    prisma.telegramUpdateInbox.update.mockResolvedValue(row);
    const bot = service.bot!;
    jest.spyOn(bot, 'isInited').mockReturnValue(true);
    const handleUpdate = jest
      .spyOn(bot, 'handleUpdate')
      .mockResolvedValue(undefined);

    const [claimed] = await service.claimInboxBatch();
    await service.processInboxRow(claimed);

    expect(
      (prisma.$queryRaw.mock.calls[0][0] as { sql: string }).sql,
    ).toContain('SKIP LOCKED');
    expect(handleUpdate).toHaveBeenCalledWith(row.payload);
    const [processedArgs] = prisma.telegramUpdateInbox.updateMany.mock.calls.at(
      -1,
    ) as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
    expect(processedArgs.where).toMatchObject({
      updateId: 9n,
      leaseToken: 'inbox-lease',
    });
    expect(processedArgs.data.processedAt).toBeInstanceOf(Date);
  });
});
