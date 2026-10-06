import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { CreateStudentDto } from './dto/create-student.dto';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  FindUsersQueryDto,
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
  findAll(@Query() query: FindUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get('students')
  findAllStudents(
    @Req() req: Express.Request,
    @Query() query: ListStudentsQueryDto,
  ) {
    const { id: userId, roles } = req.user!;
    const isStaff = roles.includes(Role.ADMIN) || roles.includes(Role.MANAGER);
    // staff видит всех; чистый препод — только своих учеников (teacherId = его userId)
    // чистый препод видит только своих учеников
    if (!isStaff && roles.includes(Role.TEACHER)) {
      query.teacherId = userId;
    }
    return this.usersService.findAllStudents(query, !isStaff);
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

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  uploadAvatar(
    @Req() req: Express.Request,
    @UploadedFile()
    file?: { buffer: Buffer },
  ) {
    if (!file?.buffer.length)
      throw new BadRequestException('Image file is required');
    return this.usersService.uploadAvatar(
      req.user!.id,
      Uint8Array.from(file.buffer),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Get(':id/avatar')
  async getAvatar(@Req() req: Express.Request, @Param('id') id: string) {
    const { id: userId, roles } = req.user!;
    const isStaff = roles.includes(Role.ADMIN) || roles.includes(Role.MANAGER);
    if (!isStaff && id !== userId) throw new ForbiddenException();

    const avatar = await this.usersService.findAvatar(id);
    return new StreamableFile(Buffer.from(avatar.data), {
      type: avatar.mimeType,
      disposition: 'inline',
    });
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
