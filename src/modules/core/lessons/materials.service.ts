import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TelegramNotifier } from '../../common/telegram/telegram.notifier';

const materialSelect = {
  id: true,
  lessonId: true,
  title: true,
  fileType: true,
  fileSize: true,
  uploadedAt: true,
} as const;

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifier: TelegramNotifier,
  ) {}

  async createUploaded(
    lessonId: string,
    file: {
      name: string;
      type: string;
      size: number;
      data: Uint8Array<ArrayBuffer>;
    },
    reportId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (reportId) {
        const report = await tx.lessonReport.findFirst({
          where: { id: reportId, lessonId },
          select: { id: true },
        });
        if (!report) {
          throw new BadRequestException('Report does not belong to lesson');
        }
      }

      const material = await tx.material.create({
        data: {
          lessonId,
          reportId,
          title: file.name,
          fileType: file.type,
          fileSize: file.size,
          fileData: file.data,
        },
        select: materialSelect,
      });
      await this.audit.record(
        {
          action: 'material.created',
          entityType: 'Material',
          entityId: material.id,
          details: { lessonId },
        },
        tx,
      );
      if (!reportId) await this.notifier.materialAdded(material.id, tx);
      return material;
    });
  }

  findByLessonId(lessonId: string) {
    return this.prisma.material.findMany({
      where: { lessonId },
      select: materialSelect,
      orderBy: { uploadedAt: 'desc' },
    });
  }

  async findFile(id: string, lessonId: string) {
    const material = await this.prisma.material.findFirst({
      where: { id, lessonId },
      select: {
        title: true,
        fileType: true,
        fileData: true,
      },
    });
    if (!material?.fileData) throw new NotFoundException('File not found');
    return {
      title: material.title,
      fileType: material.fileType,
      fileData: material.fileData,
    };
  }

  async remove(id: string, lessonId: string) {
    const material = await this.prisma.material.findFirst({
      where: { id, lessonId },
      select: { lessonId: true },
    });
    if (!material) throw new NotFoundException('Material not found');
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.material.delete({
        where: { id, lessonId },
        select: materialSelect,
      });
      await this.audit.record(
        {
          action: 'material.deleted',
          entityType: 'Material',
          entityId: id,
          details: { lessonId },
        },
        tx,
      );
      return deleted;
    });
  }
}
