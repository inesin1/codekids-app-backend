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

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async createTeacher(dto: CreateUserDto) {
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: {
        ...dto,
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
        password,
        roles: [Role.PARENT],
        parentProfile: { create: {} },
      },
      include: { parentProfile: true },
    });
  }

  async createStudent(dto: CreateStudentDto) {
    const { parentUserId, age, grade, ...userData } = dto;

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
        password,
        roles: [Role.STUDENT],
        studentProfile: {
          create: {
            age,
            grade,
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

  findAllStudents(query: ListStudentsQueryDto) {
    return this.prisma.user.findMany({
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

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        parentProfile: true,
        studentProfile: true,
      },
    });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      omit: { password: false },
    });
  }

  update(id: string, dto: UpdateUserDto) {
    return this.prisma.user.update({ where: { id }, data: dto });
  }

  delete(id: string) {
    return this.prisma.user.delete({ where: { id } });
  }
}
