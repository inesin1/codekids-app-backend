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
  async findById(@Req() req: Express.Request, @Param('id') id: string) {
    const scope = await this.resolveScope(req.user!);
    return this.lessonsService.findById(id, scope);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Post(':id/complete')
  async complete(@Req() req: Express.Request, @Param('id') id: string) {
    if (!this.isStaff(req.user!)) {
      await this.lessonsService.assertTeacherOwns(id, req.user!.id);
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

  private isStaff(user: { roles: Role[] }) {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER);
  }

  private async resolveScope(user: { id: string; roles: Role[] }) {
    if (this.isStaff(user)) {
      return undefined;
    }
    if (user.roles.includes(Role.TEACHER)) {
      return { teacherUserId: user.id };
    }
    if (user.roles.includes(Role.PARENT)) {
      const students = await this.prisma.studentProfile.findMany({
        where: { parentId: user.id },
        select: { userId: true },
      });
      return { studentUserIds: students.map((s) => s.userId) };
    }
    if (user.roles.includes(Role.STUDENT)) {
      return { studentUserIds: [user.id] };
    }
    throw new ForbiddenException();
  }
}
