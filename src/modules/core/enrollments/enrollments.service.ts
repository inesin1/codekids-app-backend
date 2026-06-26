import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';

const includeProfiles = {
  teacher: { include: { user: { omit: { password: true } } } },
  student: { include: { user: { omit: { password: true } } } },
  course: true,
} as const;

@Injectable()
export class EnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateEnrollmentDto) {
    const [teacher, student, course] = await Promise.all([
      this.findTeacherProfile(dto.teacherId),
      this.findStudentProfile(dto.studentId),
      this.prisma.course.findUnique({
        where: { id: dto.courseId },
        select: { id: true },
      }),
    ]);

    if (!teacher) {
      throw new BadRequestException(
        'teacherId must be a user id with role TEACHER',
      );
    }

    if (!student) {
      throw new BadRequestException(
        'studentId must be a user id with role STUDENT',
      );
    }

    if (!course) {
      throw new BadRequestException(
        'courseId must reference an existing course',
      );
    }

    const existing = await this.prisma.enrollment.findUnique({
      where: {
        teacherId_studentId_courseId: {
          teacherId: dto.teacherId,
          studentId: dto.studentId,
          courseId: course.id,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        'Enrollment already exists for this teacher-student-course',
      );
    }

    try {
      return await this.prisma.enrollment.create({
        data: dto,
        include: includeProfiles,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'Enrollment already exists for this teacher-student-course',
        );
      }

      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2003'
      ) {
        throw new BadRequestException(
          'teacherId, studentId and courseId must reference existing records',
        );
      }

      throw e;
    }
  }

  findAll(filters: {
    teacherId?: string;
    studentId?: string;
    courseId?: string;
    isActive?: boolean;
  }) {
    return this.prisma.enrollment.findMany({
      where: {
        teacherId: filters.teacherId,
        studentId: filters.studentId,
        courseId: filters.courseId,
        isActive: filters.isActive,
      },
      include: includeProfiles,
    });
  }

  async findById(id: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      include: includeProfiles,
    });
    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }
    return enrollment;
  }

  async update(id: string, dto: UpdateEnrollmentDto) {
    await this.findById(id);
    return this.prisma.enrollment.update({
      where: { id },
      data: dto,
      include: includeProfiles,
    });
  }

  private findTeacherProfile(userId: string) {
    return this.prisma.teacherProfile.findUnique({
      where: { userId },
      select: { userId: true },
    });
  }

  private findStudentProfile(userId: string) {
    return this.prisma.studentProfile.findUnique({
      where: { userId },
      select: { userId: true },
    });
  }
}
