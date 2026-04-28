import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { DayOfWeek, Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { ScheduleTemplatesService } from './schedule-templates.service';
import { CreateScheduleTemplateDto } from './dto/create-schedule-template.dto';
import { UpdateScheduleTemplateDto } from './dto/update-schedule-template.dto';

@Controller('schedule-templates')
export class ScheduleTemplatesController {
  constructor(private readonly templatesService: ScheduleTemplatesService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post()
  create(@Body() dto: CreateScheduleTemplateDto) {
    return this.templatesService.create(dto);
  }

  @Get()
  findAll(
    @Query('teacherId') teacherId?: string,
    @Query('studentId') studentId?: string,
    @Query('dayOfWeek') dayOfWeek?: DayOfWeek,
    @Query('isActive') isActive?: boolean,
  ) {
    return this.templatesService.findAll({
      teacherId,
      studentId,
      dayOfWeek,
      isActive,
    });
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.templatesService.findById(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateScheduleTemplateDto) {
    return this.templatesService.update(id, dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Delete(':id')
  deactivate(@Param('id') id: string) {
    return this.templatesService.deactivate(id);
  }
}
