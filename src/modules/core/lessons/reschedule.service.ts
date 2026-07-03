import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Role,
  RescheduleRequestStatus,
  RescheduleRequestType,
} from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { CreateRescheduleRequestDto } from './dto/create-reschedule-request.dto';

@Injectable()
export class RescheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lessonsService: LessonsService,
    private readonly audit: AuditService,
  ) {}

  async createRequest(
    lessonId: string,
    user: { id: string; roles: Role[] },
    dto: CreateRescheduleRequestDto,
  ) {
    if (dto.type === RescheduleRequestType.RESCHEDULE && !dto.proposedDate) {
      throw new BadRequestException(
        'proposedDate is required for RESCHEDULE type',
      );
    }

    const lesson = await this.lessonsService.findById(lessonId);
    await this.assertOwnsLesson(user, lesson.teacherId, lesson.studentId);

    const request = await this.prisma.rescheduleRequest.create({
      data: {
        lessonId,
        createdById: user.id,
        type: dto.type,
        reason: dto.reason,
        proposedDate: dto.proposedDate ? new Date(dto.proposedDate) : undefined,
      },
      include: { lesson: true, createdBy: { omit: { password: true } } },
    });
    this.audit.log({
      action: 'reschedule_request.created',
      entityType: 'RescheduleRequest',
      entityId: request.id,
      details: { lessonId, type: dto.type, proposedDate: dto.proposedDate },
    });
    return request;
  }

  // Учитель может заявлять только по своим урокам, родитель — по урокам своих детей
  private async assertOwnsLesson(
    user: { id: string; roles: Role[] },
    teacherId: string,
    studentId: string,
  ) {
    if (user.roles.includes(Role.TEACHER) && user.id === teacherId) {
      return;
    }
    if (user.roles.includes(Role.PARENT)) {
      const parent = await this.prisma.parentProfile.findUnique({
        where: { userId: user.id },
        select: { students: { select: { userId: true } } },
      });
      if (parent?.students.some((s) => s.userId === studentId)) return;
    }
    throw new ForbiddenException('You do not have access to this lesson');
  }

  findAll(filters: { status?: RescheduleRequestStatus; lessonId?: string }) {
    return this.prisma.rescheduleRequest.findMany({
      where: {
        status: filters.status,
        lessonId: filters.lessonId,
      },
      include: {
        lesson: true,
        createdBy: { omit: { password: true } },
        resolvedBy: { omit: { password: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async approve(requestId: string, resolvedByUserId: string) {
    const request = await this.findByIdOrThrow(requestId);

    if (request.status !== RescheduleRequestStatus.PENDING) {
      throw new BadRequestException('Request is already resolved');
    }

    // Изменение урока + закрытие заявки атомарно
    const approved = await this.prisma.$transaction(async (tx) => {
      if (request.type === RescheduleRequestType.CANCEL) {
        await this.lessonsService.cancelWithin(tx, request.lessonId);
      } else {
        await this.lessonsService.rescheduleWithin(tx, request.lessonId, {
          newDate: request.proposedDate!.toISOString(),
        });
      }

      return tx.rescheduleRequest.update({
        where: { id: requestId },
        data: {
          status: RescheduleRequestStatus.APPROVED,
          resolvedById: resolvedByUserId,
          resolvedAt: new Date(),
        },
        include: { lesson: true },
      });
    });
    this.audit.log({
      action: 'reschedule_request.approved',
      entityType: 'RescheduleRequest',
      entityId: requestId,
      details: {
        lessonId: request.lessonId,
        type: request.type,
        proposedDate: request.proposedDate?.toISOString(),
      },
    });
    return approved;
  }

  async reject(requestId: string, resolvedByUserId: string) {
    const request = await this.findByIdOrThrow(requestId);

    if (request.status !== RescheduleRequestStatus.PENDING) {
      throw new BadRequestException('Request is already resolved');
    }

    const rejected = await this.prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: {
        status: RescheduleRequestStatus.REJECTED,
        resolvedById: resolvedByUserId,
        resolvedAt: new Date(),
      },
      include: { lesson: true },
    });
    this.audit.log({
      action: 'reschedule_request.rejected',
      entityType: 'RescheduleRequest',
      entityId: requestId,
      details: { lessonId: request.lessonId },
    });
    return rejected;
  }

  private async findByIdOrThrow(id: string) {
    const request = await this.prisma.rescheduleRequest.findUnique({
      where: { id },
    });
    if (!request) {
      throw new NotFoundException('Reschedule request not found');
    }
    return request;
  }
}
