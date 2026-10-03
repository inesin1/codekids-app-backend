import { BadRequestException } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsersService } from './users.service';

describe('UsersService student access', () => {
  let service: UsersService;
  let prisma: {
    user: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    refreshToken: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    user: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
  };

  beforeEach(() => {
    tx = {
      user: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          studentProfile: { userId: 'student-1' },
        }),
        update: jest.fn().mockResolvedValue({
          id: 'student-1',
          firstName: 'Alex',
          lastName: 'Kid',
          email: 'family@example.test',
          birthDate: null,
          isActive: true,
          staffRoles: [],
          teacherProfile: null,
          studentProfile: {
            userId: 'student-1',
            parentName: 'Parent',
            parentContacts: [{ id: 'contact-1', label: 'Phone', value: '+1' }],
          },
        }),
      },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      user: {
        create: jest.fn().mockResolvedValue({
          id: 'student-1',
          firstName: 'Alex',
          lastName: 'Kid',
          email: 'family@example.test',
          birthDate: null,
          isActive: true,
          staffRoles: [],
          teacherProfile: null,
          studentProfile: {
            userId: 'student-1',
            parentName: 'Parent',
            parentContacts: null,
          },
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: { deleteMany: jest.fn() },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    tx.user.create = prisma.user.create;
    service = new UsersService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );
  });

  it('creates a student without login credentials and normalizes contacts', async () => {
    const result = await service.createStudent({
      firstName: 'Alex',
      lastName: 'Kid',
      email: 'family@example.test',
      parentName: 'Parent',
      parentContacts: [{ label: 'Phone', value: '+1' }],
    });

    const [[args]] = prisma.user.create.mock.calls as unknown as [
      [
        {
          data: {
            login?: string;
            password: string | null;
            email?: string;
            studentProfile: { create: { parentContacts: unknown } };
          };
        },
      ],
    ];
    expect(args.data.login).toBeUndefined();
    expect(args.data.password).toBeNull();
    expect(args.data.email).toBe('family@example.test');
    const [contact] = args.data.studentProfile.create.parentContacts as Array<
      Record<string, unknown>
    >;
    expect(contact.label).toBe('Phone');
    expect(typeof contact.id).toBe('string');
    expect(result.roles).toEqual([Role.STUDENT]);
    expect(result.studentProfile).toEqual(
      expect.objectContaining({ parentName: 'Parent', parentContacts: [] }),
    );
  });

  it('rejects partial credentials when creating a student', async () => {
    await expect(
      service.createStudent({
        firstName: 'Alex',
        lastName: 'Kid',
        login: 'alex',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it.each([
    ['roles', null],
    ['isActive', null],
  ])('rejects null for the non-nullable %s field', async (field, value) => {
    await expect(
      service.update('student-1', { [field]: value } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('clears a credential pair and revokes sessions in one transaction', async () => {
    await service.update('student-1', {
      login: null,
      password: null,
    } as never);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [[updateArgs]] = tx.user.update.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(updateArgs.data).toEqual(
      expect.objectContaining({
        login: null,
        password: null,
        securityVersion: { increment: 1 },
      }),
    );
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'student-1' },
    });
  });

  it('omits student balance from teacher list projections only', async () => {
    await service.findAllStudents({} as never, true);
    await service.findAllStudents({} as never, false);
    const [[teacherArgs], [staffArgs]] = prisma.user.findMany.mock
      .calls as unknown as [
      [
        {
          include: {
            teacherProfile: { select: { userId: boolean } };
            studentProfile: { select: Record<string, unknown> };
          };
        },
      ],
      [
        {
          include: {
            teacherProfile: { select: { userId: boolean } };
            studentProfile: { select: Record<string, unknown> };
          };
        },
      ],
    ];
    const teacherProjection = teacherArgs.include.studentProfile.select;
    expect(teacherProjection).not.toHaveProperty('balance');
    expect(teacherArgs.include.teacherProfile).toEqual({
      select: { userId: true },
    });
    const staffProjection = staffArgs.include.studentProfile.select;
    expect(staffProjection.balance).toBe(true);
  });

  it('returns bounded user pages with stable last-name ordering', async () => {
    prisma.user.count.mockResolvedValue(21);
    const result = await service.findAll({ page: 2, limit: 20 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(result).toMatchObject({
      data: [],
      meta: { itemsPerPage: 20, totalItems: 21, currentPage: 2, totalPages: 2 },
      links: {
        current: '/api/users?page=2&limit=20',
        next: '',
        last: '/api/users?page=2&limit=20',
      },
    });
  });
});
