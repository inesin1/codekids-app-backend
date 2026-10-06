import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma, Role, TelegramRecipientKind } from '../../../generated/client';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateStudentDto } from './dto/create-student.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  ListStudentsQueryDto,
  ListUsersQueryDto,
} from './dto/list-users-query.dto';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { ContactDto } from './dto/contact.dto';
import { paginated, paginationArgs } from '../../common/pagination';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private logUserCreated(
    userId: string,
    type: string,
    tx: Prisma.TransactionClient,
  ) {
    return this.audit.record(
      {
        action: 'user.created',
        entityType: 'User',
        entityId: userId,
        details: { type },
      },
      tx,
    );
  }

  private static calculateAge(birthDate: Date): number {
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
  }

  private withStudentAge<
    T extends { birthDate: Date | null; studentProfile: object | null },
  >(user: T) {
    if (!user.studentProfile) return user;
    const studentProfile = user.studentProfile as Record<string, unknown>;
    return {
      ...user,
      studentProfile: {
        ...studentProfile,
        age: user.birthDate ? UsersService.calculateAge(user.birthDate) : null,
      },
    };
  }

  /** Returns the profile relations used to derive current account roles. */
  static readonly profileExists = {
    teacherProfile: { select: { userId: true } },
    studentProfile: { select: { userId: true } },
  } satisfies Prisma.UserInclude;

  /** Derives account roles from staff roles and current role profiles. */
  static resolveRoles(user: {
    staffRoles: Role[];
    teacherProfile?: unknown;
    studentProfile?: unknown;
  }): Role[] {
    return [
      ...user.staffRoles,
      ...(user.teacherProfile ? [Role.TEACHER] : []),
      ...(user.studentProfile ? [Role.STUDENT] : []),
    ];
  }

  private static withRoles<
    T extends {
      staffRoles: Role[];
      teacherProfile?: unknown;
      studentProfile?: unknown;
    },
  >(user: T) {
    return { ...user, roles: UsersService.resolveRoles(user) };
  }

  private static isStaffRole(role: Role): boolean {
    return role === Role.ADMIN || role === Role.MANAGER;
  }

  /** Adds IDs to contacts so clients can edit individual entries. */
  private normalizeContacts(
    contacts?: ContactDto[],
  ): Prisma.InputJsonValue | undefined {
    if (!contacts) return undefined;
    return contacts.map((contact) => ({
      ...contact,
      id: contact.id ?? randomUUID(),
    }));
  }

  private async withLoginConflict<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('User with this login already exists');
      }
      throw error;
    }
  }

  private assertCredentialPair(
    login?: string | null,
    password?: string | null,
    required = false,
  ) {
    const noCredentials =
      (login === undefined && password === undefined) ||
      (login === null && password === null);
    const hasCredentials =
      typeof login === 'string' && typeof password === 'string';
    if (required && !hasCredentials) {
      throw new BadRequestException('login and password are required');
    }
    if (!noCredentials && !hasCredentials) {
      throw new BadRequestException(
        'login and password must be provided together',
      );
    }
    if (typeof login === 'string' && !login.trim()) {
      throw new BadRequestException('login must not be blank');
    }
  }

  async createTeacher(dto: CreateUserDto) {
    this.assertCredentialPair(dto.login, dto.password, true);
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.withLoginConflict(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            ...dto,
            login: dto.login.trim(),
            contacts: this.normalizeContacts(dto.contacts),
            password: hashedPassword,
            teacherProfile: { create: {} },
          },
          include: UsersService.profileExists,
        });
        await this.logUserCreated(created.id, 'teacher', tx);
        return created;
      }),
    );
    return UsersService.withRoles(user);
  }

  async createStudent(dto: CreateStudentDto) {
    this.assertCredentialPair(dto.login, dto.password);
    const { birthDate, parentName, password, login, ...userData } = dto;
    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
    const user = await this.withLoginConflict(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            ...userData,
            ...(typeof login === 'string' && { login: login.trim() }),
            contacts: this.normalizeContacts(userData.contacts),
            password: hashedPassword,
            studentProfile: {
              create: {
                parentName,
              },
            },
            ...(birthDate && { birthDate: new Date(birthDate) }),
          },
          include: { ...UsersService.profileExists, studentProfile: true },
        });
        await this.logUserCreated(created.id, 'student', tx);
        return created;
      }),
    );
    return UsersService.withRoles(this.withStudentAge(user));
  }

  async createStaff(dto: CreateStaffDto) {
    const { roles, ...userData } = dto;
    this.assertCredentialPair(userData.login, userData.password, true);
    const hashedPassword = await bcrypt.hash(userData.password, 10);
    const user = await this.withLoginConflict(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            ...userData,
            login: userData.login.trim(),
            contacts: this.normalizeContacts(userData.contacts),
            password: hashedPassword,
            staffRoles: roles.filter((role) => UsersService.isStaffRole(role)),
            ...(roles.includes(Role.TEACHER) && {
              teacherProfile: { create: {} },
            }),
          },
          include: UsersService.profileExists,
        });
        await this.logUserCreated(created.id, 'staff', tx);
        return created;
      }),
    );
    return UsersService.withRoles(user);
  }

  async findAll(query: {
    role?: Role;
    roles?: Role[];
    page: number;
    limit: number;
  }) {
    const roles = query.roles ?? (query.role ? [query.role] : []);
    const where: Prisma.UserWhereInput = roles.length
      ? { OR: roles.map((role) => this.roleFilter(role)) }
      : {};
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: UsersService.profileExists,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...paginationArgs(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(
      users.map((user) => UsersService.withRoles(user)),
      total,
      query,
      '/api/users',
      { role: query.role, roles: query.roles?.join(',') },
    );
  }

  private roleFilter(role: Role): Prisma.UserWhereInput {
    if (UsersService.isStaffRole(role)) return { staffRoles: { has: role } };
    if (role === Role.TEACHER) return { teacherProfile: { isNot: null } };
    return { studentProfile: { isNot: null } };
  }

  async findAllStudents(query: ListStudentsQueryDto, hideBalance = false) {
    const search = await this.searchFilter(query.q);
    const where: Prisma.UserWhereInput = {
      ...search,
      ...(query.isActive != null && { isActive: query.isActive }),
      studentProfile: query.teacherId
        ? {
            enrollments: {
              some: { teacherId: query.teacherId, isActive: true },
            },
          }
        : { isNot: null },
    };
    const [students, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: {
          teacherProfile: { select: { userId: true } },
          studentProfile: {
            select: {
              userId: true,
              parentName: true,
              createdAt: true,
              updatedAt: true,
              telegramGroup: { select: { isActive: true } },
              enrollments: {
                where: { isActive: true },
                select: { course: { select: { name: true } } },
              },
              ...(!hideBalance && { balance: true }),
            },
          },
        },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...paginationArgs(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(
      students.map((student) =>
        UsersService.withRoles(this.withStudentAge(student)),
      ),
      total,
      query,
      '/api/users/students',
      { q: query.q, isActive: query.isActive, teacherId: query.teacherId },
    );
  }

  async findAllTeachers(query: ListUsersQueryDto) {
    const search = await this.searchFilter(query.q);
    const where: Prisma.UserWhereInput = {
      teacherProfile: { isNot: null },
      ...search,
      ...(query.isActive != null && { isActive: query.isActive }),
    };
    const [teachers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: UsersService.profileExists,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        ...paginationArgs(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(
      teachers.map((teacher) => UsersService.withRoles(teacher)),
      total,
      query,
      '/api/users/teachers',
      { q: query.q, isActive: query.isActive },
    );
  }

  private async searchFilter(q?: string): Promise<Prisma.UserWhereInput> {
    if (!q) return {};
    const emailContacts = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT u."id"
      FROM "users" AS u
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(u."contacts") = 'array' THEN u."contacts"
            ELSE '[]'::jsonb
          END
        ) AS contact(item)
        WHERE (
          strpos(lower(COALESCE(contact.item ->> 'label', '')), 'mail') > 0
          OR strpos(lower(COALESCE(contact.item ->> 'label', '')), 'почт') > 0
        )
        AND strpos(lower(COALESCE(contact.item ->> 'value', '')), lower(${q})) > 0
      )
    `;
    return {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { login: { contains: q, mode: 'insensitive' } },
        { id: { in: emailContacts.map(({ id }) => id) } },
      ],
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        studentProfile: { include: { telegramGroup: true } },
      },
    });
    if (!user) return null;
    return UsersService.withRoles(this.withStudentAge(user));
  }

  async uploadAvatar(userId: string, data: Uint8Array<ArrayBuffer>) {
    const mimeType = UsersService.avatarMimeType(data);
    if (!mimeType) {
      throw new BadRequestException(
        'Only JPEG, PNG, and WebP images are supported',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');

      const avatar = await tx.userAvatar.upsert({
        where: { userId },
        create: { userId, mimeType, data },
        update: { mimeType, data },
        select: { updatedAt: true },
      });
      const avatarUrl = `/users/${userId}/avatar?v=${avatar.updatedAt.getTime()}`;
      await tx.user.update({ where: { id: userId }, data: { avatarUrl } });
      await this.audit.record(
        {
          action: 'user.avatar_updated',
          entityType: 'User',
          entityId: userId,
        },
        tx,
      );
      return { avatarUrl };
    });
  }

  async findAvatar(userId: string) {
    const avatar = await this.prisma.userAvatar.findUnique({
      where: { userId },
      select: { mimeType: true, data: true },
    });
    if (!avatar) throw new NotFoundException('Avatar not found');
    return avatar;
  }

  private static avatarMimeType(data: Uint8Array) {
    const header = String.fromCharCode(...data.subarray(0, 12));
    if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
    if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg';
    if (header.slice(0, 4) === 'RIFF' && header.slice(8) === 'WEBP') {
      return 'image/webp';
    }
    return null;
  }

  findByLogin(login: string) {
    return this.prisma.user.findUnique({
      where: { login },
      omit: { password: false, securityVersion: false },
      include: UsersService.profileExists,
    });
  }

  async update(id: string, dto: UpdateUserDto) {
    this.assertCredentialPair(dto.login, dto.password);
    if (dto.isActive !== undefined && typeof dto.isActive !== 'boolean') {
      throw new BadRequestException('isActive must be a boolean');
    }
    if (
      dto.roles !== undefined &&
      (!Array.isArray(dto.roles) ||
        dto.roles.some(
          (role) =>
            role !== Role.ADMIN &&
            role !== Role.MANAGER &&
            role !== Role.TEACHER,
        ))
    ) {
      throw new BadRequestException('Unsupported staff role');
    }

    const { birthDate, roles, login, password, parentName, ...userData } = dto;
    const hashedPassword =
      typeof password === 'string'
        ? await bcrypt.hash(password, 10)
        : undefined;

    const user = await this.withLoginConflict(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await tx.user.findUnique({
          where: { id },
          select: {
            isActive: true,
            studentProfile: { select: { userId: true } },
          },
        });
        if (!current) {
          throw new NotFoundException('User not found');
        }

        const hasStudentProfileUpdate = parentName !== undefined;
        if (hasStudentProfileUpdate && !current.studentProfile) {
          throw new BadRequestException(
            'Student fields can only be updated for a student',
          );
        }

        const accessChanged =
          login !== undefined ||
          password !== undefined ||
          roles !== undefined ||
          (dto.isActive !== undefined && dto.isActive !== current.isActive);

        const data: Prisma.UserUpdateInput = {
          ...userData,
          ...(typeof login === 'string' && { login: login.trim() }),
          ...(login === null && { login: null, password: null }),
          ...(hashedPassword !== undefined && { password: hashedPassword }),
          contacts: this.normalizeContacts(userData.contacts),
          ...(roles !== undefined && {
            staffRoles: roles.filter((role) => UsersService.isStaffRole(role)),
          }),
          ...(birthDate !== undefined && {
            birthDate: birthDate ? new Date(birthDate) : null,
          }),
          ...(roles?.includes(Role.TEACHER) && {
            teacherProfile: { upsert: { create: {}, update: {} } },
          }),
          ...(hasStudentProfileUpdate && {
            studentProfile: {
              update: {
                ...(parentName !== undefined && { parentName }),
              },
            },
          }),
          ...(accessChanged && { securityVersion: { increment: 1 } }),
        };

        let updated = await tx.user.update({
          where: { id },
          data,
          include: {
            ...UsersService.profileExists,
            studentProfile: { include: { telegramGroup: true } },
          },
        });
        if (accessChanged) {
          await tx.refreshToken.deleteMany({ where: { userId: id } });
        }
        if (
          !updated.isActive ||
          UsersService.resolveRoles(updated).length === 0
        ) {
          updated = await tx.user.update({
            where: { id },
            data: {
              telegramChatId: null,
              telegramBindingVersion: { increment: 1 },
            },
            include: {
              ...UsersService.profileExists,
              studentProfile: { include: { telegramGroup: true } },
            },
          });
          await tx.telegramGroup.updateMany({
            where: { studentId: id },
            data: {
              telegramChatId: null,
              isActive: false,
              bindingVersion: { increment: 1 },
            },
          });
          await tx.telegramNotification.updateMany({
            where: {
              recipientId: id,
              recipientKind: {
                in: [TelegramRecipientKind.USER, TelegramRecipientKind.GROUP],
              },
              canceledAt: null,
            },
            data: {
              canceledAt: new Date(),
              leaseToken: null,
              leaseVersion: null,
              leaseExpiresAt: null,
            },
          });
          await tx.telegramLinkToken.deleteMany({ where: { userId: id } });
          updated = await tx.user.findUniqueOrThrow({
            where: { id },
            include: {
              ...UsersService.profileExists,
              studentProfile: { include: { telegramGroup: true } },
            },
          });
        }
        await this.audit.record(
          {
            action: 'user.updated',
            entityType: 'User',
            entityId: id,
            details: {
              ...(dto.isActive !== undefined && { isActive: dto.isActive }),
              ...(roles !== undefined && { roles }),
              ...(password !== undefined && { portalCredentialsUpdated: true }),
            },
          },
          tx,
        );
        return updated;
      }),
    );

    return UsersService.withRoles(this.withStudentAge(user));
  }

  async delete(id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.audit.record(
        { action: 'user.deleted', entityType: 'User', entityId: id },
        tx,
      );
      const user = await tx.user.delete({ where: { id } });
      await tx.telegramNotification.updateMany({
        where: {
          recipientId: id,
          recipientKind: {
            in: [TelegramRecipientKind.USER, TelegramRecipientKind.GROUP],
          },
          canceledAt: null,
        },
        data: {
          canceledAt: new Date(),
          leaseToken: null,
          leaseVersion: null,
          leaseExpiresAt: null,
        },
      });
      return user;
    });
  }
}
