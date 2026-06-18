import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateLiteUserDto } from './dto/create-lite-user.dto';
import { CreateStudentDto } from './dto/create-student.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  ListStudentsQueryDto,
  ListUsersQueryDto,
} from './dto/list-users-query.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('teachers')
  createTeacher(@Body() dto: CreateUserDto) {
    return this.usersService.createTeacher(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('parents')
  createParent(@Body() dto: CreateLiteUserDto) {
    return this.usersService.createParent(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('students')
  createStudent(@Body() dto: CreateStudentDto) {
    return this.usersService.createStudent(dto);
  }

  @Roles(Role.ADMIN)
  @Post('staff')
  createStaff(@Body() dto: CreateStaffDto) {
    return this.usersService.createStaff(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get()
  findAll(@Query('role') role?: Role) {
    return this.usersService.findAll(role);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get('students')
  async findAllStudents(
    @Req() req: Express.Request,
    @Query() query: ListStudentsQueryDto,
  ) {
    if (req.user!.roles.includes(Role.TEACHER)) {
      query.teacherId = await this.usersService.getTeacherProfileIdByUserId(
        req.user!.id,
      );
    }
    return this.usersService.findAllStudents(query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('parents')
  findAllParents(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAllParents(query);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get('teachers')
  findAllTeachers(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAllTeachers(query);
  }

  @Get(':id')
  findById(@Req() req: Express.Request, @Param('id') id: string) {
    const { id: userId, roles } = req.user!;
    const isStaff = roles.includes(Role.ADMIN) || roles.includes(Role.MANAGER);
    if (!isStaff && id !== userId) {
      throw new ForbiddenException();
    }
    return this.usersService.findById(id);
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.usersService.delete(id);
  }
}
