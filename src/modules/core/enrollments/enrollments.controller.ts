import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
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

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get()
  findAll(@Req() req: Express.Request, @Query() query: FindEnrollmentsDto) {
    const { id: userId, roles } = req.user!;
    const isStaff = roles.includes(Role.ADMIN) || roles.includes(Role.MANAGER);
    // staff видит всё; чистый препод — только свои энроллменты (teacherId = его userId)
    if (!isStaff && roles.includes(Role.TEACHER)) {
      query.teacherId = userId;
    }
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
