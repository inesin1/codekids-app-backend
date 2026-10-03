import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { RescheduleService } from './reschedule.service';
import { CreateRescheduleRequestDto } from './dto/create-reschedule-request.dto';
import { FindRescheduleRequestsDto } from './dto/find-reschedule-requests.dto';

@Controller()
export class RescheduleController {
  constructor(private readonly rescheduleService: RescheduleService) {}

  @Roles(Role.TEACHER, Role.STUDENT)
  @Post('lessons/:lessonId/reschedule-requests')
  createRequest(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateRescheduleRequestDto,
  ) {
    return this.rescheduleService.createRequest(lessonId, req.user!, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER, Role.STUDENT)
  @Get('reschedule-requests')
  findAll(
    @Req() req: Express.Request,
    @Query() query: FindRescheduleRequestsDto,
  ) {
    return this.rescheduleService.findAll(query, req.user!);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER, Role.STUDENT)
  @Post('reschedule-requests/:id/approve')
  approve(@Req() req: Express.Request, @Param('id') id: string) {
    return this.rescheduleService.approve(id, req.user!);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER, Role.STUDENT)
  @Post('reschedule-requests/:id/reject')
  reject(@Req() req: Express.Request, @Param('id') id: string) {
    return this.rescheduleService.reject(id, req.user!);
  }
}
