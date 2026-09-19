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
    if (reportId) {
      const report = await this.prisma.lessonReport.findFirst({
        where: { id: reportId, lessonId },
        select: { id: true },
      });
      if (!report) {
        throw new BadRequestException('Report does not belong to lesson');
      }
    }

    const material = await this.prisma.material.create({
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
    this.audit.log({
      action: 'material.created',
      entityType: 'Material',
      entityId: material.id,
      details: { lessonId },
    });
    if (!reportId) this.notifier.materialAdded(material.id);
    return material;
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

  async getLessonId(id: string): Promise<string | null> {
    const material = await this.prisma.material.findUnique({
      where: { id },
      select: { lessonId: true },
    });
    if (!material) throw new NotFoundException('Material not found');
    return material.lessonId;
  }

  async remove(id: string) {
    const material = await this.prisma.material.findUnique({
      where: { id },
      select: { lessonId: true },
    });
    if (!material) throw new NotFoundException('Material not found');
    const deleted = await this.prisma.material.delete({
      where: { id },
      select: materialSelect,
    });
    this.audit.log({
      action: 'material.deleted',
      entityType: 'Material',
      entityId: id,
      details: { lessonId: material.lessonId },
    });
    return deleted;
  }
}
