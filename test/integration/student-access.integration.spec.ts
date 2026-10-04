import { ConfigService } from '@nestjs/config';
import {
  LessonStatus,
  RescheduleRequestType,
  Role,
} from '../../src/generated/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { AuthService } from '../../src/modules/common/auth/auth.service';
import { JwtAuthGuard } from '../../src/modules/common/auth/guards/auth.guard';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { TelegramNotifier } from '../../src/modules/common/telegram/telegram.notifier';
import { TelegramService } from '../../src/modules/common/telegram/telegram.service';
import { AuditService } from '../../src/modules/common/audit/audit.service';
import { LessonsService } from '../../src/modules/core/lessons/lessons.service';
import { LessonsController } from '../../src/modules/core/lessons/lessons.controller';
import { MaterialsService } from '../../src/modules/core/lessons/materials.service';
import { MaterialsController } from '../../src/modules/core/lessons/materials.controller';
import { ReportsService } from '../../src/modules/core/lessons/reports.service';
import { ReportsController } from '../../src/modules/core/lessons/reports.controller';
import { RescheduleService } from '../../src/modules/core/lessons/reschedule.service';
import { UsersService } from '../../src/modules/core/users/users.service';
import { UsersController } from '../../src/modules/core/users/users.controller';
import { CreateStudentDto } from '../../src/modules/core/users/dto/create-student.dto';
import { randomUUID } from 'node:crypto';

describe('student-owned portal resources with PostgreSQL', () => {
  let prisma: PrismaService;
  let teacherId: string;
  let managerId: string;
  let firstStudentId: string;
  let secondStudentId: string;
  let courseId: string;
  let enrollmentId: string;
  let firstLessonId: string;
  let secondLessonId: string;
  let scheduledRequestLessonId: string | undefined;
  let materialId: string;
  let audit: { log: jest.Mock; record: jest.Mock };
  let notifier: Record<string, jest.Mock>;
  let lessons: LessonsService;
  let lessonsController: LessonsController;
  let materialsController: MaterialsController;
  let reportsController: ReportsController;
  let reschedules: RescheduleService;
  let serviceCreatedStudentIds: string[];

  beforeAll(async () => {
    prisma = new PrismaService({
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return process.env['DATABASE_URL'];
        throw new Error(`Unexpected config key: ${key}`);
      },
    } as ConfigService);
    await prisma.$connect();
  });

  beforeEach(async () => {
    scheduledRequestLessonId = undefined;
    serviceCreatedStudentIds = [];
    const suffix = randomUUID();
    teacherId = `integration-teacher-${suffix}`;
    managerId = `integration-manager-${suffix}`;
    firstStudentId = `integration-student-a-${suffix}`;
    secondStudentId = `integration-student-b-${suffix}`;
    courseId = `integration-course-${suffix}`;
    enrollmentId = `integration-enrollment-${suffix}`;
    firstLessonId = `integration-lesson-a-${suffix}`;
    secondLessonId = `integration-lesson-b-${suffix}`;

    await prisma.user.create({
      data: {
        id: teacherId,
        telegramChatId: '90001',
        firstName: 'Integration',
        lastName: 'Teacher',
        teacherProfile: { create: {} },
      },
    });
    await prisma.user.create({
      data: {
        id: managerId,
        firstName: 'Integration',
        lastName: 'Manager',
        staffRoles: [Role.MANAGER],
        teacherProfile: { create: {} },
        studentProfile: { create: { balance: '5.25' } },
      },
    });
    await prisma.user.createMany({
      data: [
        {
          id: firstStudentId,
          contacts: [{ label: 'Email', value: 'shared-parent@example.test' }],
          telegramChatId: '90001',
          firstName: 'Student',
          lastName: 'One',
        },
        {
          id: secondStudentId,
          contacts: [{ label: 'Email', value: 'shared-parent@example.test' }],
          telegramChatId: '90001',
          firstName: 'Student',
          lastName: 'Two',
        },
      ],
    });
    await prisma.studentProfile.createMany({
      data: [
        { userId: firstStudentId, balance: '11.25' },
        { userId: secondStudentId, balance: '99.75' },
      ],
    });
    await prisma.course.create({ data: { id: courseId, name: courseId } });
    await prisma.enrollment.create({
      data: {
        id: enrollmentId,
        teacherId,
        studentId: firstStudentId,
        courseId,
        lessonPrice: '25.00',
        teacherRate: '12.00',
      },
    });
    const secondEnrollmentId = `integration-enrollment-b-${suffix}`;
    await prisma.enrollment.create({
      data: {
        id: secondEnrollmentId,
        teacherId,
        studentId: secondStudentId,
        courseId,
        lessonPrice: '30.00',
        teacherRate: '15.00',
      },
    });
    await prisma.lesson.createMany({
      data: [
        {
          id: firstLessonId,
          enrollmentId,
          teacherId,
          studentId: firstStudentId,
          scheduledAt: new Date('2026-10-01T10:00:00.000Z'),
          status: LessonStatus.COMPLETED,
        },
        {
          id: secondLessonId,
          enrollmentId: secondEnrollmentId,
          teacherId,
          studentId: secondStudentId,
          scheduledAt: new Date('2026-10-01T11:00:00.000Z'),
          status: LessonStatus.COMPLETED,
        },
      ],
    });
    await prisma.lessonReport.createMany({
      data: [
        {
          lessonId: firstLessonId,
          topic: 'First topic',
          covered: 'First covered',
          results: 'First result',
          extraNotes: 'first internal note',
        },
        {
          lessonId: secondLessonId,
          topic: 'Second topic',
          covered: 'Second covered',
          results: 'Second result',
          extraNotes: 'second internal note',
        },
      ],
    });
    const material = await prisma.material.create({
      data: {
        lessonId: firstLessonId,
        title: 'student-file.txt',
        fileType: 'text/plain',
        fileData: Buffer.from('synthetic lesson file'),
      },
    });
    materialId = material.id;

    audit = { log: jest.fn(), record: jest.fn().mockResolvedValue(undefined) };
    notifier = new Proxy(
      {},
      { get: () => jest.fn().mockResolvedValue(undefined) },
    ) as Record<string, jest.Mock>;
    const telegram = { bot: undefined } as unknown as TelegramService;
    lessons = new LessonsService(
      prisma,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
    );
    lessonsController = new LessonsController(lessons, {} as never);
    const materials = new MaterialsService(
      prisma,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
    );
    materialsController = new MaterialsController(materials, lessons);
    const reports = new ReportsService(
      prisma,
      audit as unknown as AuditService,
      notifier as unknown as TelegramNotifier,
      { get: () => 50 } as unknown as ConfigService,
    );
    reportsController = new ReportsController(reports, lessons);
    reschedules = new RescheduleService(
      prisma,
      lessons,
      audit as unknown as AuditService,
      telegram,
      notifier as unknown as TelegramNotifier,
    );
  });

  afterEach(async () => {
    const lessonIds = [firstLessonId, secondLessonId];
    if (scheduledRequestLessonId) lessonIds.push(scheduledRequestLessonId);
    await prisma.rescheduleRequest.deleteMany({
      where: { lessonId: { in: lessonIds } },
    });
    await prisma.material.deleteMany({ where: { lessonId: firstLessonId } });
    await prisma.lessonReport.deleteMany({
      where: { lessonId: { in: [firstLessonId, secondLessonId] } },
    });
    await prisma.lesson.deleteMany({
      where: { id: { in: lessonIds } },
    });
    await prisma.enrollment.deleteMany({ where: { courseId } });
    await prisma.course.deleteMany({ where: { id: courseId } });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            firstStudentId,
            secondStudentId,
            teacherId,
            managerId,
            ...serviceCreatedStudentIds,
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps repeated contacts and Telegram IDs independent and scopes lessons, reports, files, balances, and requests to each student', async () => {
    const firstUser = await prisma.user.findUniqueOrThrow({
      where: { id: firstStudentId },
    });
    const secondUser = await prisma.user.findUniqueOrThrow({
      where: { id: secondStudentId },
    });
    expect(firstUser.contacts).toEqual(secondUser.contacts);
    expect(firstUser.telegramChatId).toBe(secondUser.telegramChatId);

    const balances = await prisma.studentProfile.findMany({
      where: { userId: { in: [firstStudentId, secondStudentId] } },
      orderBy: { userId: 'asc' },
    });
    expect(balances.map(({ balance }) => balance.toFixed(2))).toEqual([
      '11.25',
      '99.75',
    ]);

    const firstActor = { id: firstStudentId, roles: [Role.STUDENT] };
    const secondActor = { id: secondStudentId, roles: [Role.STUDENT] };
    const request = (actor: { id: string; roles: Role[] }) =>
      ({ user: actor }) as unknown as Express.Request;

    const firstLessons = await lessonsController.findAll(request(firstActor), {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-01',
      studentId: secondStudentId,
      page: 1,
      limit: 20,
    });
    expect(firstLessons.data.map(({ id }) => id)).toEqual([firstLessonId]);
    expect(firstLessons.data[0].report?.extraNotes).toBeNull();
    expect((await lessons.findById(firstLessonId)).report?.extraNotes).toBe(
      'first internal note',
    );
    const firstLessonCard = await lessonsController.findById(
      request(firstActor),
      firstLessonId,
    );
    expect(firstLessonCard.report?.extraNotes).toBeNull();
    await expect(
      lessonsController.findById(request(firstActor), secondLessonId),
    ).rejects.toMatchObject({ status: 403 });

    const visibleReport = await reportsController.findByLessonId(
      request(firstActor),
      firstLessonId,
    );
    expect(visibleReport.extraNotes).toBeNull();
    await expect(
      reportsController.findByLessonId(request(firstActor), secondLessonId),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      await materialsController.findByLessonId(
        request(firstActor),
        firstLessonId,
      ),
    ).toHaveLength(1);
    await expect(
      materialsController.findByLessonId(request(firstActor), secondLessonId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      materialsController.download(
        request(secondActor),
        firstLessonId,
        materialId,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      reschedules.createRequest(secondLessonId, firstActor, {
        type: RescheduleRequestType.CANCEL,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const scheduledRequestLesson = await prisma.lesson.create({
      data: {
        enrollmentId,
        teacherId,
        studentId: firstStudentId,
        scheduledAt: new Date('2026-10-05T10:00:00Z'),
      },
    });
    scheduledRequestLessonId = scheduledRequestLesson.id;
    const ownRequest = await reschedules.createRequest(
      scheduledRequestLesson.id,
      firstActor,
      {
        type: RescheduleRequestType.CANCEL,
      },
    );
    const requestFilters = { page: 1, limit: 20 };
    expect(
      (await reschedules.findAll(requestFilters, secondActor)).data,
    ).toHaveLength(0);
    expect(
      (await reschedules.findAll(requestFilters, firstActor)).data,
    ).toHaveLength(1);
    expect(ownRequest.lessonId).toBe(scheduledRequestLesson.id);

    const creatorOwnRequest = await prisma.rescheduleRequest.create({
      data: {
        lessonId: scheduledRequestLesson.id,
        createdById: teacherId,
        type: RescheduleRequestType.CANCEL,
      },
    });
    const resolveTelegramActor = Reflect.get(
      reschedules,
      'findTelegramActor',
    ) as unknown as (
      this: RescheduleService,
      telegramUserId: number,
      requestId: string,
    ) => Promise<unknown>;
    await expect(
      resolveTelegramActor.call(reschedules, 90001, creatorOwnRequest.id),
    ).resolves.toBeNull();

    const auditService = { log: jest.fn(), record: jest.fn() };
    const usersService = new UsersService(
      prisma,
      auditService as unknown as AuditService,
    );
    const usersController = new UsersController(usersService);
    const studentListQuery = { page: 1, limit: 20 };
    const teacherStudentRows = await usersController.findAllStudents(
      request({ id: teacherId, roles: [Role.TEACHER] }),
      studentListQuery,
    );
    expect(teacherStudentRows.data.map(({ id }) => id).sort()).toEqual(
      [firstStudentId, secondStudentId].sort(),
    );
    expect(
      teacherStudentRows.data.every(
        (student) => !('balance' in (student.studentProfile ?? {})),
      ),
    ).toBe(true);
    const managerStudentRows = await usersController.findAllStudents(
      request({ id: managerId, roles: [Role.MANAGER] }),
      studentListQuery,
    );
    expect(
      managerStudentRows.data.every(
        (student) => 'balance' in (student.studentProfile ?? {}),
      ),
    ).toBe(true);
    const multiProfileManager = (
      await usersService.findAll({ page: 1, limit: 100 })
    ).data.find((user) => user.id === managerId);
    expect(multiProfileManager?.roles).toEqual([
      Role.MANAGER,
      Role.TEACHER,
      Role.STUDENT,
    ]);
    const authPayloads: {
      sub?: string;
      roles?: Role[];
      securityVersion?: number;
    }[] = [];
    const auth = new AuthService(
      usersService,
      {
        signAsync: jest.fn(
          (payload: {
            sub: string;
            roles: Role[];
            securityVersion: number;
          }) => {
            authPayloads.push(payload);
            return Promise.resolve(
              `access-${payload.sub}-${authPayloads.length}`,
            );
          },
        ),
      } as never,
      prisma,
      {
        getOrThrow: (key: string) => {
          if (key === 'JWT_REFRESH_TTL') return '1d';
          throw new Error(`Unexpected config key: ${key}`);
        },
      } as unknown as ConfigService,
    );
    const longLogin = 'l'.repeat(254);
    const validDto = plainToInstance(CreateStudentDto, {
      firstName: 'Portal',
      lastName: 'One',
      login: longLogin,
      password: 'portal-password-one',
      contacts: [{ label: 'Email', value: 'same-contact@example.test' }],
    });
    expect(await validate(validDto)).toHaveLength(0);
    const invalidLongLogin = plainToInstance(CreateStudentDto, {
      ...validDto,
      login: `${longLogin}x`,
    });
    expect(
      (await validate(invalidLongLogin)).some(
        (error) => error.property === 'login',
      ),
    ).toBe(true);

    const createdFirst = await usersService.createStudent(validDto);
    const createdSecond = await usersService.createStudent(
      Object.assign(new CreateStudentDto(), {
        firstName: 'Portal',
        lastName: 'Two',
        login: 'portal-student-two',
        password: 'portal-password-two',
        contacts: [{ label: 'Email', value: 'same-contact@example.test' }],
      }),
    );
    serviceCreatedStudentIds.push(createdFirst.id, createdSecond.id);
    await prisma.studentProfile.update({
      where: { userId: createdFirst.id },
      data: { balance: '3.50' },
    });
    await prisma.studentProfile.update({
      where: { userId: createdSecond.id },
      data: { balance: '80.00' },
    });

    const firstLogin = await auth.login(longLogin, 'portal-password-one');
    const secondLogin = await auth.login(
      'portal-student-two',
      'portal-password-two',
    );
    expect(firstLogin.user.id).toBe(createdFirst.id);
    expect(secondLogin.user.id).toBe(createdSecond.id);
    expect(firstLogin.user.roles).toEqual([Role.STUDENT]);
    expect(secondLogin.user.roles).toEqual([Role.STUDENT]);
    expect(authPayloads.map(({ sub }) => sub)).toEqual([
      createdFirst.id,
      createdSecond.id,
    ]);

    const ownerRequest = (id: string) =>
      ({ user: { id, roles: [Role.STUDENT] } }) as unknown as Express.Request;
    const ownerProfile = await usersController.findById(
      ownerRequest(createdFirst.id),
      createdFirst.id,
    );
    expect(ownerProfile?.studentProfile?.balance.toString()).toBe('3.5');
    await expect(
      Promise.resolve().then(() =>
        usersController.findById(
          ownerRequest(createdFirst.id),
          createdSecond.id,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });

    const noAccess = await usersService.createStudent(
      Object.assign(new CreateStudentDto(), {
        firstName: 'Portal',
        lastName: 'No Access',
      }),
    );
    serviceCreatedStudentIds.push(noAccess.id);
    await expect(
      auth.login('grant-after-create', 'grant-password'),
    ).rejects.toMatchObject({
      status: 401,
    });
    await usersService.update(noAccess.id, {
      login: 'grant-after-create',
      password: 'grant-password',
    });
    const granted = await auth.login('grant-after-create', 'grant-password');
    const oldRefreshToken = granted.refreshToken;
    const oldSecurityVersion = authPayloads[2].securityVersion;
    expect(oldSecurityVersion).toBe(1);
    expect(
      await prisma.refreshToken.count({ where: { userId: noAccess.id } }),
    ).toBe(1);

    const oldAccessPayload = authPayloads[2];
    const accessGuard = new JwtAuthGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue(oldAccessPayload),
      } as unknown as JwtService,
      { getOrThrow: () => 'integration-secret' } as unknown as ConfigService,
      { getAllAndOverride: () => false } as unknown as Reflector,
      prisma,
    );
    const accessContext = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer old-access-token' },
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(accessGuard.canActivate(accessContext)).resolves.toBe(true);

    await usersService.update(noAccess.id, { login: null, password: null });
    expect(
      await prisma.refreshToken.count({ where: { userId: noAccess.id } }),
    ).toBe(0);
    await expect(auth.refresh(oldRefreshToken)).rejects.toMatchObject({
      status: 401,
    });
    const noAccessRecord = await prisma.user.findUniqueOrThrow({
      where: { id: noAccess.id },
      omit: { password: false, securityVersion: false },
    });
    expect(noAccessRecord.login).toBeNull();
    expect(noAccessRecord.password).toBeNull();
    expect(noAccessRecord.securityVersion).toBe(2);
    await expect(accessGuard.canActivate(accessContext)).rejects.toMatchObject({
      status: 401,
    });
  });
});
