import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCourseDto) {
    try {
      return await this.prisma.course.create({ data: dto });
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
    await this.findById(id);
    try {
      return await this.prisma.course.update({ where: { id }, data: dto });
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
