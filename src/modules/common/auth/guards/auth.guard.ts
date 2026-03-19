import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Токен отсутствует');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        role: string;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });

      request.user = { id: payload.sub, role: payload.role };
    } catch {
      throw new UnauthorizedException('Токен невалиден или истёк');
    }

    return true;
  }

  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.substring(7);
  }
}
