import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { MaterialsService } from './materials.service';
import { CreateMaterialDto } from './dto/create-material.dto';

@Controller('lessons/:lessonId/materials')
export class MaterialsController {
  constructor(
    private readonly materialsService: MaterialsService,
    private readonly lessonsService: LessonsService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Post()
  async create(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateMaterialDto,
  ) {
    if (req.user!.role === Role.TEACHER) {
      const profile = await this.prisma.teacherProfile.findUniqueOrThrow({
        where: { userId: req.user!.id },
      });
      await this.lessonsService.assertTeacherOwns(lessonId, profile.id);
    }
    return this.materialsService.create(lessonId, dto);
  }

  @Get()
  findByLessonId(@Param('lessonId') lessonId: string) {
    return this.materialsService.findByLessonId(lessonId);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.materialsService.remove(id);
  }
}
