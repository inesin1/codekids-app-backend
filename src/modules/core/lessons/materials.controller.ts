import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { LessonsService } from './lessons.service';
import { MaterialsService } from './materials.service';
import { CreateMaterialDto } from './dto/create-material.dto';

@Controller('lessons/:lessonId/materials')
export class MaterialsController {
  constructor(
    private readonly materialsService: MaterialsService,
    private readonly lessonsService: LessonsService,
  ) {}

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Post()
  async create(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateMaterialDto,
  ) {
    await this.assertAccess(req.user!, lessonId);
    return this.materialsService.create(lessonId, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get()
  async findByLessonId(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
  ) {
    await this.assertAccess(req.user!, lessonId);
    return this.materialsService.findByLessonId(lessonId);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Delete(':id')
  async remove(@Req() req: Express.Request, @Param('id') id: string) {
    if (!this.isStaff(req.user!)) {
      const lessonId = await this.materialsService.getLessonId(id);
      await this.assertAccess(req.user!, lessonId);
    }
    return this.materialsService.remove(id);
  }

  private isStaff(user: { roles: Role[] }) {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER);
  }

  private async assertAccess(
    user: { id: string; roles: Role[] },
    lessonId: string | null,
  ) {
    if (this.isStaff(user)) return;
    if (!lessonId) throw new ForbiddenException();
    const teacherId = await this.lessonsService.getTeacherProfileId(user.id);
    await this.lessonsService.assertTeacherOwns(lessonId, teacherId);
  }
}
