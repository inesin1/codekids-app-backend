import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Role } from '../../../generated/client';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateStudentDto } from './dto/create-student.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  createTeacher(dto: CreateUserDto) {
    return this.prisma.user.create({
      data: {
        ...dto,
        role: Role.TEACHER,
        teacherProfile: { create: {} },
      },
      include: { teacherProfile: true },
    });
  }

  createParent(dto: CreateUserDto) {
    return this.prisma.user.create({
      data: {
        ...dto,
        role: Role.PARENT,
        parentProfile: { create: {} },
      },
      include: { parentProfile: true },
    });
  }

  createStudent(dto: CreateStudentDto) {
    const { parentId, age, grade, ...userData } = dto;
    return this.prisma.user.create({
      data: {
        ...userData,
        role: Role.STUDENT,
        studentProfile: { create: { parentId, age, grade } },
      },
      include: { studentProfile: true },
    });
  }

  createStaff(dto: CreateStaffDto) {
    return this.prisma.user.create({ data: dto });
  }

  findAll(role?: Role) {
    return this.prisma.user.findMany({
      where: role ? { role } : undefined,
    });
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

  update(id: string, dto: UpdateUserDto) {
    return this.prisma.user.update({ where: { id }, data: dto });
  }

  delete(id: string) {
    return this.prisma.user.delete({ where: { id } });
  }
}
