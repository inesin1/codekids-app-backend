import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { ReportsService } from './reports.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';

@Controller('lessons/:lessonId/report')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly lessonsService: LessonsService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(Role.TEACHER)
  @Post()
  async create(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateReportDto,
  ) {
    const profile = await this.prisma.teacherProfile.findUniqueOrThrow({
      where: { userId: req.user!.id },
    });
    await this.lessonsService.assertTeacherOwns(lessonId, profile.id);
    return this.reportsService.create(lessonId, dto);
  }

  @Get()
  findByLessonId(@Param('lessonId') lessonId: string) {
    return this.reportsService.findByLessonId(lessonId);
  }

  @Roles(Role.TEACHER)
  @Patch()
  async update(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateReportDto,
  ) {
    const profile = await this.prisma.teacherProfile.findUniqueOrThrow({
      where: { userId: req.user!.id },
    });
    await this.lessonsService.assertTeacherOwns(lessonId, profile.id);
    return this.reportsService.update(lessonId, dto);
  }
}
