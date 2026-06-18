import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { EnrollmentsService } from './enrollments.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { FindEnrollmentsDto } from './dto/find-enrollments.dto';

@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post()
  create(@Body() dto: CreateEnrollmentDto) {
    return this.enrollmentsService.create(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get()
  findAll(@Query() query: FindEnrollmentsDto) {
    return this.enrollmentsService.findAll(query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get(':id')
  findById(@Param('id') id: string) {
    return this.enrollmentsService.findById(id);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnrollmentDto) {
    return this.enrollmentsService.update(id, dto);
  }
}
