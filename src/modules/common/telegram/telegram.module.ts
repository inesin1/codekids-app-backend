import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramNotifier } from './telegram.notifier';
import { TelegramService } from './telegram.service';

@Module({
  controllers: [TelegramController],
  providers: [TelegramService, TelegramNotifier],
  exports: [TelegramService, TelegramNotifier],
})
export class TelegramModule {}
