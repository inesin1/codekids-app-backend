import { Controller, Get } from '@nestjs/common';
import { Public } from './modules/common/auth/decorators/public.decorator';

@Controller()
export class HealthController {
  @Public()
  @Get('check')
  check(): string {
    return 'ok';
  }
}
