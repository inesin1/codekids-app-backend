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
        'teacherId must be an existing teacher profile id or teacher user id',
      );
    }

    if (!student) {
      throw new BadRequestException(
        'studentId must be an existing student profile id or student user id',
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
          teacherId: teacher.id,
          studentId: student.id,
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
        data: {
          ...dto,
          teacherId: teacher.id,
          studentId: student.id,
        },
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

  private findTeacherProfile(id: string) {
    return this.prisma.teacherProfile.findFirst({
      where: { OR: [{ id }, { userId: id }] },
      select: { id: true },
    });
  }

  private findStudentProfile(id: string) {
    return this.prisma.studentProfile.findFirst({
      where: { OR: [{ id }, { userId: id }] },
      select: { id: true },
    });
  }
}
