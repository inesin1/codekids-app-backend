import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { LessonStatus, Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { CreateLessonDto } from './dto/create-lesson.dto';
import { RescheduleLessonDto } from './dto/reschedule-lesson.dto';

@Controller('lessons')
export class LessonsController {
  constructor(
    private readonly lessonsService: LessonsService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('generate')
  generate() {
    return this.lessonsService.generate();
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post()
  create(@Body() dto: CreateLessonDto) {
    return this.lessonsService.create(dto);
  }

  @Get()
  async findAll(
    @Req() req: Express.Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: LessonStatus,
    @Query('teacherId') teacherId?: string,
    @Query('studentId') studentId?: string,
  ) {
    const scope = await this.resolveScope(req.user!);
    return this.lessonsService.findAll(
      { from, to, status, teacherId, studentId },
      scope,
    );
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.lessonsService.findById(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Post(':id/complete')
  async complete(@Req() req: Express.Request, @Param('id') id: string) {
    if (req.user!.role === Role.TEACHER) {
      const profile = await this.getTeacherProfile(req.user!.id);
      await this.lessonsService.assertTeacherOwns(id, profile.id);
    }
    return this.lessonsService.complete(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.lessonsService.cancel(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post(':id/reschedule')
  reschedule(@Param('id') id: string, @Body() dto: RescheduleLessonDto) {
    return this.lessonsService.reschedule(id, dto);
  }

  private async resolveScope(user: { id: string; role: string }) {
    if (user.role === Role.ADMIN || user.role === Role.MANAGER) {
      return undefined;
    }
    if (user.role === Role.TEACHER) {
      const profile = await this.getTeacherProfile(user.id);
      return { teacherProfileId: profile.id };
    }
    if (user.role === Role.PARENT) {
      const profile = await this.prisma.parentProfile.findUniqueOrThrow({
        where: { userId: user.id },
        include: { students: { select: { id: true } } },
      });
      return { studentProfileIds: profile.students.map((s) => s.id) };
    }
    if (user.role === Role.STUDENT) {
      const profile = await this.prisma.studentProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      return { studentProfileIds: [profile.id] };
    }
    throw new ForbiddenException();
  }

  private async getTeacherProfile(userId: string) {
    return this.prisma.teacherProfile.findUniqueOrThrow({
      where: { userId },
    });
  }
}
