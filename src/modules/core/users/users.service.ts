import { BadRequestException, Injectable } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

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

  // Догенерируем id отсутствующим контактам, чтобы фронт мог точечно редактировать.
  // undefined → поле не трогаем (Prisma пропускает).
  private normalizeContacts(
    contacts?: ContactDto[],
  ): Prisma.InputJsonValue | undefined {
    if (!contacts) return undefined;
    return contacts.map((c) => ({ ...c, id: c.id ?? randomUUID() }));
  }

  async createTeacher(dto: CreateUserDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: {
        ...dto,
        contacts: this.normalizeContacts(dto.contacts),
        password: hashedPassword,
        roles: [Role.TEACHER],
        teacherProfile: { create: {} },
      },
      include: { teacherProfile: true },
    });
  }

  async createParent(dto: CreateLiteUserDto) {
    const password = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    return this.prisma.user.create({
      data: {
        ...dto,
        contacts: this.normalizeContacts(dto.contacts),
        password,
        roles: [Role.PARENT],
        parentProfile: { create: {} },
      },
      include: { parentProfile: true },
    });
  }

  async createStudent(dto: CreateStudentDto) {
    const { parentUserId, birthDate, ...userData } = dto;

    let parentId: string | undefined;
    if (parentUserId) {
      const parentProfile = await this.prisma.parentProfile.findUnique({
        where: { userId: parentUserId },
        select: { id: true },
      });
      if (!parentProfile) {
        throw new BadRequestException(
          'Parent not found. parentUserId must be a user id with role PARENT',
        );
      }
      parentId = parentProfile.id;
    }

    const password = userData.password
      ? await bcrypt.hash(userData.password, 10)
      : null;
    return this.prisma.user.create({
      data: {
        ...userData,
        contacts: this.normalizeContacts(userData.contacts),
        password,
        roles: [Role.STUDENT],
        studentProfile: {
          create: {
            ...(birthDate && { birthDate: new Date(birthDate) }),
            ...(parentId && { parent: { connect: { id: parentId } } }),
          },
        },
      },
      include: { studentProfile: true },
    });
  }

  async createStaff(dto: CreateStaffDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: {
        ...dto,
        contacts: this.normalizeContacts(dto.contacts),
        password: hashedPassword,
        // если staff ещё и преподаёт — заводим teacher-профиль
        ...(dto.roles.includes(Role.TEACHER) && {
          teacherProfile: { create: {} },
        }),
      },
      include: { teacherProfile: true },
    });
  }

  findAll(role?: Role) {
    return this.prisma.user.findMany({
      where: role ? { roles: { has: role } } : undefined,
    });
  }

  async findAllStudents(query: ListStudentsQueryDto) {
    const students = await this.prisma.user.findMany({
      where: {
        roles: { has: Role.STUDENT },
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
        ...(query.teacherId && {
          studentProfile: {
            enrollments: {
              some: { teacherId: query.teacherId, isActive: true },
            },
          },
        }),
      },
      include: {
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
    return students.map((s) => this.withStudentAge(s));
  }

  findAllParents(query: ListUsersQueryDto) {
    return this.prisma.user.findMany({
      where: {
        roles: { has: Role.PARENT },
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
      },
      include: { parentProfile: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  findAllTeachers(query: ListUsersQueryDto) {
    return this.prisma.user.findMany({
      where: {
        roles: { has: Role.TEACHER },
        ...this.searchFilter(query.q),
        ...(query.isActive != null && { isActive: query.isActive }),
      },
      include: { teacherProfile: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTeacherProfileIdByUserId(userId: string): Promise<string> {
    const profile = await this.prisma.teacherProfile.findUniqueOrThrow({
      where: { userId },
      select: { id: true },
    });
    return profile.id;
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
    return {
      ...this.withStudentAge(user),
      ...(user.parentProfile && {
        parentProfile: {
          ...user.parentProfile,
          students: user.parentProfile.students.map((s) =>
            UsersService.withAge(s),
          ),
        },
      }),
    };
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      omit: { password: false },
    });
  }

  async update(id: string, dto: UpdateUserDto) {
    const { birthDate, ...userData } = dto;
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...userData,
        contacts: this.normalizeContacts(userData.contacts),
        ...(birthDate !== undefined && {
          studentProfile: { update: { birthDate } },
        }),
      },
      include: { studentProfile: true },
    });
    return this.withStudentAge(user);
  }

  delete(id: string) {
    return this.prisma.user.delete({ where: { id } });
  }
}
