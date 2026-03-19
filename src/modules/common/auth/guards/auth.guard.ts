import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class SimpleAuthGuard implements CanActivate {
  constructor(
    private configService: ConfigService,
    private reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Проверяем есть ли декоратор @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true; // Пропускаем без проверки
    }

    const request = context.switchToHttp().getRequest<Request>();

    const validToken = this.configService.getOrThrow<string>('AMO_TOKEN');

    // Проверка токена
    const token = this.extractToken(request);
    if (!token || token !== validToken) {
      throw new UnauthorizedException('Токен неверный или отсутствует');
    }

    return true;
  }

  /** Достает токен из запроса */
  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.substring(7);
  }
}
