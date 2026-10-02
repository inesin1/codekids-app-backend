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
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../../../core/users/users.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
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

    let payload: { sub?: unknown; securityVersion?: unknown };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub?: unknown;
        securityVersion?: unknown;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Токен невалиден или истёк');
    }

    if (
      typeof payload.sub !== 'string' ||
      !Number.isInteger(payload.securityVersion)
    ) {
      throw new UnauthorizedException('Токен невалиден или истёк');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      omit: { securityVersion: false },
      include: UsersService.profileExists,
    });
    if (!user?.isActive || user.securityVersion !== payload.securityVersion) {
      throw new UnauthorizedException('Токен отозван');
    }
    const roles = UsersService.resolveRoles(user);
    if (!roles.length) {
      throw new UnauthorizedException('У пользователя нет доступа');
    }

    request.user = { id: user.id, roles };

    return true;
  }

  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.substring(7);
  }
}
