import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma, Role } from '../../../generated/client';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateLiteUserDto } from './dto/create-lite-user.dto';
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

  private logUserCreated(userId: string, email: string | null, type: string) {
    this.audit.log({
      action: 'user.created',
      entityType: 'User',
      entityId: userId,
      details: { email, type },
    });
  }

  private static calculateAge(birthDate: Date): number {
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
  }

  // Обогащаем студенческий профиль вычисленным возрастом.
  private static withAge<T extends { birthDate: Date | null }>(profile: T) {
    return {
      ...profile,
      age: profile.birthDate
        ? UsersService.calculateAge(profile.birthDate)
        : null,
    };
  }

  private withStudentAge<
    T extends { studentProfile: { birthDate: Date | null } | null },
  >(user: T) {
    if (!user.studentProfile) return user;
    return {
      ...user,
      studentProfile: UsersService.withAge(user.studentProfile),
    };
  }

  // Минимальный select для определения участия по наличию профиля.
  static readonly profileExists = {
    teacherProfile: { select: { userId: true } },
    parentProfile: { select: { userId: true } },
    studentProfile: { select: { userId: true } },
  } satisfies Prisma.UserInclude;

  // authz-роли = staffRoles + участие, выведенное из наличия профилей.
  static resolveRoles(user: {
    staffRoles: Role[];
    teacherProfile?: unknown;
    parentProfile?: unknown;
    studentProfile?: unknown;
  }): Role[] {
    return [
      ...user.staffRoles,
      ...(user.teacherProfile ? [Role.TEACHER] : []),
      ...(user.parentProfile ? [Role.PARENT] : []),
      ...(user.studentProfile ? [Role.STUDENT] : []),
    ];
  }

  // Прикрепляем вычисленные roles к ответу (контракт чтения для фронта неизменен).
  private static withRoles<
    T extends {
      staffRoles: Role[];
      teacherProfile?: unknown;
      parentProfile?: unknown;
      studentProfile?: unknown;
    },
  >(user: T) {
    return { ...user, roles: UsersService.resolveRoles(user) };
  }

  private static isStaffRole(role: Role): boolean {
    return role === Role.ADMIN || role === Role.MANAGER;
  }

  // Догенерируем id отсутствующим контактам, чтобы фронт мог точечно редактировать.
  // undefined → поле не трогаем (Prisma пропускает).
  private normalizeContacts(
    contacts?: ContactDto[],
  ): Prisma.InputJsonValue | undefined {
    if (!contacts) return undefined;
    return contacts.map((c) => ({ ...c, id: c.id ?? randomUUID() }));
  }

  // Превращаем P2002 по email в читаемый 409 вместо сырого 500.
  private async withEmailConflict<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('User with this email already exists');
      }
      throw e;
    }
  }

  async createTeacher(dto: CreateUserDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.withEmailConflict(() =>
      this.prisma.user.create({
        data: {
          ...dto,
          contacts: this.normalizeContacts(dto.contacts),
          password: hashedPassword,
          teacherProfile: { create: {} },
        },
        include: UsersService.profileExists,
      }),
    );
    this.logUserCreated(user.id, user.email, 'teacher');
    return UsersService.withRoles(user);
  }

  async createParent(dto: CreateLiteUserDto) {
    const password = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    const user = await this.withEmailConflict(() =>
      this.prisma.user.create({
        data: {
          ...dto,
          contacts: this.normalizeContacts(dto.contacts),
          password,
          parentProfile: { create: {} },
        },
        include: { ...UsersService.profileExists, parentProfile: true },
      }),
    );
    this.logUserCreated(user.id, user.email, 'parent');
    return UsersService.withRoles(user);
  }

  async createStudent(dto: CreateStudentDto) {
    const { parentUserId, birthDate, ...userData } = dto;

    if (parentUserId) {
      const parentProfile = await this.prisma.parentProfile.findUnique({
        where: { userId: parentUserId },
        select: { userId: true },
      });
      if (!parentProfile) {
        throw new BadRequestException(
          'Parent not found. parentUserId must be a user id with role PARENT',
        );
      }
    }

    const password = userData.password
      ? await bcrypt.hash(userData.password, 10)
      : null;
    const user = await this.withEmailConflict(() =>
      this.prisma.user.create({
        data: {
          ...userData,
          contacts: this.normalizeContacts(userData.contacts),
          password,
          studentProfile: {
            create: {
              ...(birthDate && { birthDate: new Date(birthDate) }),
              ...(parentUserId && {
                parent: { connect: { userId: parentUserId } },
              }),
            },
          },
        },
        include: { ...UsersService.profileExists, studentProfile: true },
      }),
    );
    this.logUserCreated(user.id, user.email, 'student');
    return UsersService.withRoles(this.withStudentAge(user));
  }

  async createStaff(dto: CreateStaffDto) {
    const { roles, ...userData } = dto;
    const hashedPassword = await bcrypt.hash(userData.password, 10);
    const user = await this.withEmailConflict(() =>
      this.prisma.user.create({
        data: {
          ...userData,
          contacts: this.normalizeContacts(userData.contacts),
          password: hashedPassword,
          staffRoles: roles.filter((r) => UsersService.isStaffRole(r)),
          // если staff ещё и преподаёт — заводим teacher-профиль
          ...(roles.includes(Role.TEACHER) && {
            teacherProfile: { create: {} },
          }),
        },
        include: UsersService.profileExists,
      }),
    );
    this.logUserCreated(user.id, user.email, 'staff');
    return UsersService.withRoles(user);
  }

  async findAll(role?: Role) {
    const users = await this.prisma.user.findMany({
      where: role ? this.roleFilter(role) : undefined,
      include: UsersService.profileExists,
    });
    return users.map((u) => UsersService.withRoles(u));
  }

  // Маппинг роли в фильтр: staff — по колонке, участники — по наличию профиля.
  private roleFilter(role: Role): Prisma.UserWhereInput {
    if (UsersService.isStaffRole(role)) return { staffRoles: { has: role } };
    if (role === Role.TEACHER) return { teacherProfile: { isNot: null } };
    if (role === Role.PARENT) return { parentProfile: { isNot: null } };
    return { studentProfile: { isNot: null } };
  }

  async findAllStudents(query: ListStudentsQueryDto) {
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
        parentProfile: { select: { userId: true } },
        studentProfile: {
          include: {
            parent: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return students.map((s) => UsersService.withRoles(this.withStudentAge(s)));
  }

  async findAllParents(query: ListUsersQueryDto) {
    const parents = await this.prisma.user.findMany({
      where: {
        parentProfile: { isNot: null },
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
      },
      include: { ...UsersService.profileExists, parentProfile: true },
      orderBy: { createdAt: 'desc' },
    });
    return parents.map((u) => UsersService.withRoles(u));
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
    return teachers.map((u) => UsersService.withRoles(u));
  }

  private searchFilter(q?: string): Prisma.UserWhereInput {
    if (!q) return {};
    return {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        parentProfile: {
          include: {
            students: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
        studentProfile: true,
      },
    });
    if (!user) return null;
    return UsersService.withRoles({
      ...this.withStudentAge(user),
      ...(user.parentProfile && {
        parentProfile: {
          ...user.parentProfile,
          students: user.parentProfile.students.map((s) =>
            UsersService.withAge(s),
          ),
        },
      }),
    });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      omit: { password: false },
      include: UsersService.profileExists,
    });
  }

  async update(id: string, dto: UpdateUserDto) {
    const { birthDate, roles, password, ...userData } = dto;

    // Выдача доступа в ЛК: пароль только парой с email (both-or-neither).
    if (password != null && userData.email == null) {
      throw new BadRequestException('email is required to grant portal access');
    }
    const hashedPassword =
      password != null ? await bcrypt.hash(password, 10) : undefined;

    const user = await this.withEmailConflict(() =>
      this.prisma.user.update({
        where: { id },
        data: {
          ...userData,
          ...(hashedPassword !== undefined && { password: hashedPassword }),
          contacts: this.normalizeContacts(userData.contacts),
          ...(roles && {
            staffRoles: roles.filter((r) => UsersService.isStaffRole(r)),
          }),
          ...(birthDate !== undefined && {
            studentProfile: {
              update: { birthDate: birthDate ? new Date(birthDate) : null },
            },
          }),
          // назначили роль TEACHER → гарантируем наличие профиля (additive)
          ...(roles?.includes(Role.TEACHER) && {
            teacherProfile: { upsert: { create: {}, update: {} } },
          }),
        },
        include: { ...UsersService.profileExists, studentProfile: true },
      }),
    );
    this.audit.log({
      action: 'user.updated',
      entityType: 'User',
      entityId: id,
      // без password; выдачу доступа в ЛК фиксируем флагом
      details: {
        ...userData,
        roles,
        birthDate,
        ...(password != null && { portalAccessGranted: true }),
      },
    });
    return UsersService.withRoles(this.withStudentAge(user));
  }

  async delete(id: string) {
    const user = await this.prisma.user.delete({ where: { id } });
    this.audit.log({
      action: 'user.deleted',
      entityType: 'User',
      entityId: id,
      details: { email: user.email },
    });
    return user;
  }
}
