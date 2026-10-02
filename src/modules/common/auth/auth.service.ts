import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Prisma, Role } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../../core/users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async login(login: string, password: string) {
    const user = await this.usersService.findByLogin(login.trim());
    if (
      !user?.password ||
      !user.isActive ||
      !(await bcrypt.compare(password, user.password))
    ) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, user.id);
      const current = await tx.user.findUnique({
        where: { id: user.id },
        omit: { password: false, securityVersion: false },
        include: UsersService.profileExists,
      });
      if (
        !current?.isActive ||
        current.login !== login.trim() ||
        !current.password ||
        !(await bcrypt.compare(password, current.password))
      ) {
        throw new UnauthorizedException('Неверный логин или пароль');
      }

      const roles = UsersService.resolveRoles(current);
      if (!roles.length) {
        throw new UnauthorizedException(
          'У пользователя нет доступа к кабинету',
        );
      }
      const tokens = await this.generateTokens(
        current.id,
        roles,
        current.securityVersion,
        tx,
      );
      return { ...tokens, user: this.safeUser(current, roles) };
    });
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!stored || stored.expiresAt <= new Date()) {
      if (stored) {
        await this.prisma.refreshToken.deleteMany({
          where: { id: stored.id, expiresAt: { lte: new Date() } },
        });
      }
      throw new UnauthorizedException('Refresh token невалиден или истёк');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, stored.userId);
      const user = await tx.user.findUnique({
        where: { id: stored.userId },
        omit: { password: false, securityVersion: false },
        include: UsersService.profileExists,
      });
      if (!user?.isActive) {
        throw new UnauthorizedException('Пользователь неактивен');
      }

      const roles = UsersService.resolveRoles(user);
      if (!roles.length) {
        throw new UnauthorizedException(
          'У пользователя нет доступа к кабинету',
        );
      }

      const consumed = await tx.refreshToken.deleteMany({
        where: { id: stored.id, expiresAt: { gt: new Date() } },
      });
      if (consumed.count !== 1) {
        throw new UnauthorizedException('Refresh token уже использован');
      }

      const tokens = await this.generateTokens(
        user.id,
        roles,
        user.securityVersion,
        tx,
      );
      return { ...tokens, user: this.safeUser(user, roles) };
    });
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
  }

  private async generateTokens(
    userId: string,
    roles: Role[],
    securityVersion: number,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const payload = { sub: userId, roles, securityVersion };
    const accessToken = await this.jwtService.signAsync(payload);

    const refreshToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(refreshToken);
    const refreshTtl = this.config.getOrThrow<string>('JWT_REFRESH_TTL');
    const expiresAt = new Date(Date.now() + this.parseTtl(refreshTtl));

    await db.refreshToken.create({
      data: { userId, tokenHash, expiresAt },
    });

    return { accessToken, refreshToken };
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
    );
    if (!rows.length) throw new UnauthorizedException('Пользователь не найден');
  }

  private safeUser<
    T extends {
      password: string | null;
      securityVersion: number;
      teacherProfile?: unknown;
      studentProfile?: unknown;
    },
  >(user: T, roles: Role[]) {
    const {
      password: _password,
      securityVersion: _securityVersion,
      teacherProfile: _teacher,
      studentProfile: _student,
      ...safeUser
    } = user;
    return { ...safeUser, roles };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseTtl(ttl: string): number {
    const match = ttl.match(/^(\d+)(s|m|h|d)$/);
    if (!match) throw new Error(`Invalid TTL format: ${ttl}`);

    const value = parseInt(match[1]);
    const unit = match[2];
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

    return value * multipliers[unit as keyof typeof multipliers];
  }
}
