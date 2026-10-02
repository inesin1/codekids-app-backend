import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateCourseDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const course = await tx.course.create({ data: dto });
        await this.audit.record(
          {
            action: 'course.created',
            entityType: 'Course',
            entityId: course.id,
            details: { name: course.name },
          },
          tx,
        );
        return course;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Course with this name already exists');
      }
      throw e;
    }
  }

  findAll(filters: { isActive?: boolean }) {
    return this.prisma.course.findMany({
      where: { isActive: filters.isActive },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    const course = await this.prisma.course.findUnique({ where: { id } });
    if (!course) {
      throw new NotFoundException('Course not found');
    }
    return course;
  }

  async update(id: string, dto: UpdateCourseDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.course.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Course not found');
        const course = await tx.course.update({
          where: { id },
          data: dto,
        });
        await this.audit.record(
          {
            action: 'course.updated',
            entityType: 'Course',
            entityId: id,
            details: { ...dto },
          },
          tx,
        );
        return course;
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Course with this name already exists');
      }
      throw e;
    }
  }
}
