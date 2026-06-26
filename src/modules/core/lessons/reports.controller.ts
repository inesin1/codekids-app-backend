import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { LessonsService } from './lessons.service';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

@Controller('lessons/:lessonId/report')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly lessonsService: LessonsService,
  ) {}

  @Roles(Role.TEACHER)
  @Post()
  async create(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateReportDto,
  ) {
    await this.assertTeacherOwns(req.user!.id, lessonId);
    return this.reportsService.create(lessonId, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get()
  async findByLessonId(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
  ) {
    if (!this.isStaff(req.user!)) {
      await this.assertTeacherOwns(req.user!.id, lessonId);
    }
    return this.reportsService.findByLessonId(lessonId);
  }

  @Roles(Role.TEACHER)
  @Patch()
  async update(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateReportDto,
  ) {
    await this.assertTeacherOwns(req.user!.id, lessonId);
    return this.reportsService.update(lessonId, dto);
  }

  private isStaff(user: { roles: Role[] }) {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER);
  }

  private assertTeacherOwns(userId: string, lessonId: string) {
    return this.lessonsService.assertTeacherOwns(lessonId, userId);
  }
}
