import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './modules/common/auth/decorators/public.decorator';
import { PrismaService } from './modules/common/prisma/prisma.service';
import { TelegramService } from './modules/common/telegram/telegram.service';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get('check')
  check(): string {
    return 'ok';
  }

  @Public()
  @SkipThrottle()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        postgres: 'unavailable',
      });
    }
    return {
      status: 'ready',
      postgres: 'ready',
      telegram: this.telegram.readiness,
    };
  }
}
