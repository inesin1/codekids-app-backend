import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateMaterialDto } from './dto/create-material.dto';

@Injectable()
export class MaterialsService {
  constructor(private readonly prisma: PrismaService) {}

  create(lessonId: string, dto: CreateMaterialDto) {
    return this.prisma.material.create({
      data: { lessonId, ...dto },
    });
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
    return this.prisma.material.delete({ where: { id } });
  }
}
