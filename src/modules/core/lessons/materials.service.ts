import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateMaterialDto } from './dto/create-material.dto';

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(lessonId: string, dto: CreateMaterialDto) {
    const material = await this.prisma.material.create({
      data: { lessonId, ...dto },
    });
    this.audit.log({
      action: 'material.created',
      entityType: 'Material',
      entityId: material.id,
      details: { lessonId },
    });
    return material;
  }

  findByLessonId(lessonId: string) {
    return this.prisma.material.findMany({
      where: { lessonId },
      orderBy: { uploadedAt: 'desc' },
    });
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
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    const deleted = await this.prisma.material.delete({ where: { id } });
    this.audit.log({
      action: 'material.deleted',
      entityType: 'Material',
      entityId: id,
      details: { lessonId: material.lessonId },
    });
    return deleted;
  }
}
