import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { RescheduleRequestStatus, Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { RescheduleService } from './reschedule.service';
import { CreateRescheduleRequestDto } from './dto/create-reschedule-request.dto';

@Controller()
export class RescheduleController {
  constructor(private readonly rescheduleService: RescheduleService) {}

  @Roles(Role.TEACHER, Role.PARENT)
  @Post('lessons/:lessonId/reschedule-requests')
  createRequest(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body() dto: CreateRescheduleRequestDto,
  ) {
    return this.rescheduleService.createRequest(lessonId, req.user!, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('reschedule-requests')
  findAll(
    @Query('status') status?: RescheduleRequestStatus,
    @Query('lessonId') lessonId?: string,
  ) {
    return this.rescheduleService.findAll({ status, lessonId });
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('reschedule-requests/:id/approve')
  approve(@Req() req: Express.Request, @Param('id') id: string) {
    return this.rescheduleService.approve(id, req.user!.id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('reschedule-requests/:id/reject')
  reject(@Req() req: Express.Request, @Param('id') id: string) {
    return this.rescheduleService.reject(id, req.user!.id);
  }
}
