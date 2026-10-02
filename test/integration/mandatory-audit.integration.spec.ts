import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import {
  NotificationType,
  TelegramLinkKind,
  TelegramRecipientKind,
} from '../../src/generated/client';
import { AuditService } from '../../src/modules/common/audit/audit.service';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { CoursesService } from '../../src/modules/core/courses/courses.service';
import { LessonGenerationService } from '../../src/modules/core/lessons/lesson-generation.service';
import { LessonsService } from '../../src/modules/core/lessons/lessons.service';
import { UsersService } from '../../src/modules/core/users/users.service';

describe('Mandatory audit rollback with PostgreSQL', () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let users: UsersService;
  let courses: CoursesService;
  let userId: string;
  let courseId: string;

  beforeAll(async () => {
    prisma = new PrismaService({
      getOrThrow: () => process.env['DATABASE_URL'],
    } as unknown as ConfigService);
    await prisma.$connect();
    audit = new AuditService(prisma, {
      isActive: () => false,
    } as unknown as ClsService);
    users = new UsersService(prisma, audit);
    courses = new CoursesService(prisma, audit);
  });

  beforeEach(async () => {
    userId = randomUUID();
    courseId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        firstName: 'Fixture',
        lastName: 'Student',
        studentProfile: { create: {} },
      },
    });
    await prisma.course.create({
      data: { id: courseId, name: `Fixture-${courseId}` },
    });
    jest
      .spyOn(audit, 'record')
      .mockRejectedValue(new Error('synthetic mandatory audit failure'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.telegramNotification.deleteMany({
      where: { recipientId: userId },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('does not leave a newly created student without its audit event', async () => {
    await expect(
      users.createStudent({ firstName: `New-${userId}`, lastName: 'Fixture' }),
    ).rejects.toThrow('synthetic mandatory audit failure');
    expect(
      await prisma.user.count({ where: { firstName: `New-${userId}` } }),
    ).toBe(0);
  });

  it('rolls back deactivation, security version and refresh revocation together', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: '1234567' },
    });
    await prisma.telegramGroup.create({
      data: { studentId: userId, telegramChatId: '-1234567' },
    });
    await prisma.telegramLinkToken.create({
      data: {
        token: randomUUID(),
        kind: TelegramLinkKind.PRIVATE,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    for (const recipientKind of [
      TelegramRecipientKind.USER,
      TelegramRecipientKind.GROUP,
    ]) {
      await prisma.telegramNotification.create({
        data: {
          eventKey: randomUUID(),
          occurrenceKey: 'fixture',
          recipientKind,
          recipientId: userId,
          chatId:
            recipientKind === TelegramRecipientKind.USER
              ? '1234567'
              : '-1234567',
          type: NotificationType.LESSON_REPORT,
          text: 'Fixture',
          payloadHash: 'fixture',
          leaseToken: 'fixture-lease',
          leaseVersion: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
    }
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(users.update(userId, { isActive: false })).rejects.toThrow(
      'synthetic mandatory audit failure',
    );
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      omit: { securityVersion: false },
    });
    expect(user.isActive).toBe(true);
    expect(user.securityVersion).toBe(0);
    expect(user.telegramBindingVersion).toBe(0);
    expect(user.telegramChatId).toBe('1234567');
    expect(
      (
        await prisma.telegramGroup.findUniqueOrThrow({
          where: { studentId: userId },
        })
      ).bindingVersion,
    ).toBe(0);
    expect(
      await prisma.telegramNotification.count({
        where: {
          recipientId: userId,
          canceledAt: null,
          leaseToken: 'fixture-lease',
        },
      }),
    ).toBe(2);
    expect(await prisma.telegramLinkToken.count({ where: { userId } })).toBe(1);
    expect(await prisma.refreshToken.count({ where: { userId } })).toBe(1);
    jest.restoreAllMocks();
    await users.update(userId, { isActive: false });
    const revoked = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(revoked.telegramChatId).toBeNull();
    expect(revoked.telegramBindingVersion).toBe(1);
    const group = await prisma.telegramGroup.findUniqueOrThrow({
      where: { studentId: userId },
    });
    expect(group.isActive).toBe(false);
    expect(group.telegramChatId).toBeNull();
    expect(group.bindingVersion).toBe(1);
    expect(
      await prisma.telegramNotification.count({
        where: {
          recipientId: userId,
          canceledAt: { not: null },
          leaseToken: null,
        },
      }),
    ).toBe(2);
    expect(await prisma.telegramLinkToken.count({ where: { userId } })).toBe(0);
  });

  it('does not delete a user or its profile when mandatory audit fails', async () => {
    await expect(users.delete(userId)).rejects.toThrow(
      'synthetic mandatory audit failure',
    );
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    expect(await prisma.studentProfile.count({ where: { userId } })).toBe(1);
  });

  it('rolls back course creation and update', async () => {
    const newName = `New-${courseId}`;
    await expect(courses.create({ name: newName })).rejects.toThrow(
      'synthetic mandatory audit failure',
    );
    expect(await prisma.course.count({ where: { name: newName } })).toBe(0);
    await expect(courses.update(courseId, { name: newName })).rejects.toThrow(
      'synthetic mandatory audit failure',
    );
    expect(
      (await prisma.course.findUniqueOrThrow({ where: { id: courseId } })).name,
    ).toBe(`Fixture-${courseId}`);
  });

  it('does not change generation settings when audit persistence fails', async () => {
    const service = new LessonGenerationService(
      prisma,
      {} as LessonsService,
      audit,
    );
    const before = await prisma.lessonGenerationSettings.findUnique({
      where: { id: 'singleton' },
    });
    await expect(
      service.updateSettings({ enabled: !before?.enabled }),
    ).rejects.toThrow('synthetic mandatory audit failure');
    expect(
      await prisma.lessonGenerationSettings.findUnique({
        where: { id: 'singleton' },
      }),
    ).toEqual(before);
  });
});
