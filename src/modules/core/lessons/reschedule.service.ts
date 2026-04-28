import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  RescheduleRequestStatus,
  RescheduleRequestType,
} from '../../../generated/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { CreateRescheduleRequestDto } from './dto/create-reschedule-request.dto';

@Injectable()
export class RescheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lessonsService: LessonsService,
  ) {}

  async createRequest(
    lessonId: string,
    userId: string,
    dto: CreateRescheduleRequestDto,
  ) {
    if (dto.type === RescheduleRequestType.RESCHEDULE && !dto.proposedDate) {
      throw new BadRequestException(
        'proposedDate is required for RESCHEDULE type',
      );
    }

    await this.lessonsService.findById(lessonId);

    return this.prisma.rescheduleRequest.create({
      data: {
        lessonId,
        createdById: userId,
        type: dto.type,
        reason: dto.reason,
        proposedDate: dto.proposedDate ? new Date(dto.proposedDate) : undefined,
      },
      include: { lesson: true, createdBy: { omit: { password: true } } },
    });
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

    // Execute the actual cancel/reschedule
    if (request.type === RescheduleRequestType.CANCEL) {
      await this.lessonsService.cancel(request.lessonId);
    } else {
      await this.lessonsService.reschedule(request.lessonId, {
        newDate: request.proposedDate!.toISOString(),
      });
    }

    return this.prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: {
        status: RescheduleRequestStatus.APPROVED,
        resolvedById: resolvedByUserId,
        resolvedAt: new Date(),
      },
      include: { lesson: true },
    });
  }

  async reject(requestId: string, resolvedByUserId: string) {
    const request = await this.findByIdOrThrow(requestId);

    if (request.status !== RescheduleRequestStatus.PENDING) {
      throw new BadRequestException('Request is already resolved');
    }

    return this.prisma.rescheduleRequest.update({
      where: { id: requestId },
      data: {
        status: RescheduleRequestStatus.REJECTED,
        resolvedById: resolvedByUserId,
        resolvedAt: new Date(),
      },
      include: { lesson: true },
    });
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
