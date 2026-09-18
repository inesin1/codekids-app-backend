import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Update } from 'grammy/types';
import { Role } from '../../../generated/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  // Update — интерфейс без class-validator, валидация пропускается
  @Public()
  @SkipThrottle()
  @Post('webhook')
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() update: Update,
  ) {
    if (!this.telegram.isValidWebhookSecret(secret)) {
      throw new UnauthorizedException();
    }
    await this.telegram.handleUpdate(update);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('groups/:studentId/link')
  createGroupLink(@Param('studentId') studentId: string) {
    return this.telegram.createGroupLink(studentId);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Delete('groups/:studentId')
  unlinkGroup(@Param('studentId') studentId: string) {
    return this.telegram.unlinkGroup(studentId);
  }

  // генерация ссылки сотрудником (в т.ч. для пользователей без доступа в ЛК)
  @Post('users/:userId/link')
  createUserLink(@Req() req: Express.Request, @Param('userId') userId: string) {
    this.assertSelfOrStaff(req, userId);
    return this.telegram.createUserLink(userId);
  }

  @Delete('users/:userId/link')
  unlinkUser(@Req() req: Express.Request, @Param('userId') userId: string) {
    this.assertSelfOrStaff(req, userId);
    return this.telegram.unlinkUser(userId);
  }

  private assertSelfOrStaff(req: Express.Request, userId: string) {
    const { id, roles } = req.user!;
    const isStaff = roles.includes(Role.ADMIN) || roles.includes(Role.MANAGER);
    if (!isStaff && id !== userId) throw new ForbiddenException();
  }
}
