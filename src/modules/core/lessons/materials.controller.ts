import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { LessonsService } from './lessons.service';
import { MaterialsService } from './materials.service';

@Controller('lessons/:lessonId/materials')
export class MaterialsController {
  constructor(
    private readonly materialsService: MaterialsService,
    private readonly lessonsService: LessonsService,
  ) {}

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  async upload(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Body('reportId') reportId?: string,
    @UploadedFile()
    file?: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ) {
    if (!file) throw new BadRequestException('File is required');
    await this.assertAccess(req.user!, lessonId);
    return this.materialsService.createUploaded(
      lessonId,
      {
        name: file.originalname,
        type: file.mimetype || 'application/octet-stream',
        size: file.size,
        data: Uint8Array.from(file.buffer),
      },
      reportId,
    );
  }

  @Get(':id/file')
  async download(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
    @Param('id') id: string,
  ) {
    const material = await this.materialsService.findFile(id, lessonId);
    await this.lessonsService.assertUserCanView(lessonId, req.user!);
    return new StreamableFile(Buffer.from(material.fileData), {
      type: material.fileType ?? 'application/octet-stream',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(material.title)}`,
    });
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get()
  async findByLessonId(
    @Req() req: Express.Request,
    @Param('lessonId') lessonId: string,
  ) {
    await this.assertAccess(req.user!, lessonId);
    return this.materialsService.findByLessonId(lessonId);
  }

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Delete(':id')
  async remove(@Req() req: Express.Request, @Param('id') id: string) {
    if (!this.isStaff(req.user!)) {
      const lessonId = await this.materialsService.getLessonId(id);
      await this.assertAccess(req.user!, lessonId);
    }
    return this.materialsService.remove(id);
  }

  private isStaff(user: { roles: Role[] }) {
    return user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER);
  }

  private async assertAccess(
    user: { id: string; roles: Role[] },
    lessonId: string | null,
  ) {
    if (this.isStaff(user)) return;
    if (!lessonId) throw new ForbiddenException();
    await this.lessonsService.assertTeacherOwns(lessonId, user.id);
  }
}
