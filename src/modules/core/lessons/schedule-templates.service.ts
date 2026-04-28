import { Injectable, NotFoundException } from '@nestjs/common';
import { DayOfWeek, Prisma } from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateScheduleTemplateDto } from './dto/create-schedule-template.dto';
import { UpdateScheduleTemplateDto } from './dto/update-schedule-template.dto';

const scheduleTemplateInclude: Prisma.ScheduleTemplateInclude = {
  slots: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
  teacher: { include: { user: true } },
  student: { include: { user: true } },
};

@Injectable()
export class ScheduleTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateScheduleTemplateDto) {
    return this.prisma.scheduleTemplate.create({
      data: {
        enrollmentId: dto.enrollmentId,
        teacherId: dto.teacherId,
        studentId: dto.studentId,
        slots: {
          create: dto.slots.map((slot) => ({
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            durationMinutes: slot.durationMinutes,
          })),
        },
      },
      include: scheduleTemplateInclude,
    });
  }

  findAll(filters: {
    teacherId?: string;
    studentId?: string;
    dayOfWeek?: DayOfWeek;
    isActive?: boolean;
  }) {
    return this.prisma.scheduleTemplate.findMany({
      where: {
        teacherId: filters.teacherId,
        studentId: filters.studentId,
        isActive: filters.isActive ?? true,
        ...(filters.dayOfWeek && {
          slots: { some: { dayOfWeek: filters.dayOfWeek } },
        }),
      },
      include: scheduleTemplateInclude,
    });
  }

  async findById(id: string) {
    const template = await this.prisma.scheduleTemplate.findUnique({
      where: { id },
      include: scheduleTemplateInclude,
    });
    if (!template) {
      throw new NotFoundException('Schedule template not found');
    }
    return template;
  }

  async update(id: string, dto: UpdateScheduleTemplateDto) {
    await this.findById(id);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isActive !== undefined) {
        await tx.scheduleTemplate.update({
          where: { id },
          data: { isActive: dto.isActive },
        });
      }

      if (dto.slots) {
        await tx.scheduleTemplateSlot.deleteMany({
          where: { templateId: id },
        });

        await tx.scheduleTemplateSlot.createMany({
          data: dto.slots.map((slot) => ({
            templateId: id,
            dayOfWeek: slot.dayOfWeek,
            startTime: slot.startTime,
            durationMinutes: slot.durationMinutes,
          })),
        });
      }

      return tx.scheduleTemplate.findUniqueOrThrow({
        where: { id },
        include: scheduleTemplateInclude,
      });
    });
  }

  async deactivate(id: string) {
    await this.findById(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.scheduleTemplateSlot.updateMany({
        where: { templateId: id },
        data: { isActive: false },
      });

      return tx.scheduleTemplate.update({
        where: { id },
        data: { isActive: false },
        include: scheduleTemplateInclude,
      });
    });
  }

  findActive() {
    return this.prisma.scheduleTemplate.findMany({
      where: { isActive: true },
      include: {
        enrollment: true,
        slots: {
          where: { isActive: true },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
    });
  }
}
