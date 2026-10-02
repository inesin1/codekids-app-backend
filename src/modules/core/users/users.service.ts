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
        parentContacts: studentProfile.parentContacts ?? [],
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
    const {
      birthDate,
      parentName,
      parentContacts,
      password,
      login,
      ...userData
    } = dto;
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
                parentContacts: this.normalizeContacts(parentContacts),
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

  async findAll(role?: Role) {
    const users = await this.prisma.user.findMany({
      where: role ? this.roleFilter(role) : undefined,
      include: UsersService.profileExists,
    });
    return users.map((user) => UsersService.withRoles(user));
  }

  private roleFilter(role: Role): Prisma.UserWhereInput {
    if (UsersService.isStaffRole(role)) return { staffRoles: { has: role } };
    if (role === Role.TEACHER) return { teacherProfile: { isNot: null } };
    return { studentProfile: { isNot: null } };
  }

  async findAllStudents(query: ListStudentsQueryDto, hideBalance = false) {
    const students = await this.prisma.user.findMany({
      where: {
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
        studentProfile: query.teacherId
          ? {
              enrollments: {
                some: { teacherId: query.teacherId, isActive: true },
              },
            }
          : { isNot: null },
      },
      include: {
        teacherProfile: { select: { userId: true } },
        studentProfile: {
          select: {
            userId: true,
            parentName: true,
            parentContacts: true,
            createdAt: true,
            updatedAt: true,
            telegramGroup: { select: { isActive: true } },
            ...(!hideBalance && { balance: true }),
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return students.map((student) =>
      UsersService.withRoles(this.withStudentAge(student)),
    );
  }

  async findAllTeachers(query: ListUsersQueryDto) {
    const teachers = await this.prisma.user.findMany({
      where: {
        teacherProfile: { isNot: null },
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
      },
      include: UsersService.profileExists,
      orderBy: { createdAt: 'desc' },
    });
    return teachers.map((user) => UsersService.withRoles(user));
  }

  private searchFilter(q?: string): Prisma.UserWhereInput {
    if (!q) return {};
    return {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { login: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
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

    const {
      birthDate,
      roles,
      login,
      password,
      parentName,
      parentContacts,
      ...userData
    } = dto;
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

        const hasStudentProfileUpdate =
          parentName !== undefined || parentContacts !== undefined;
        if (hasStudentProfileUpdate && !current.studentProfile) {
          throw new BadRequestException(
            'Parent contacts can only be updated for a student',
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
                ...(parentContacts !== undefined && {
                  parentContacts: this.normalizeContacts(parentContacts),
                }),
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
