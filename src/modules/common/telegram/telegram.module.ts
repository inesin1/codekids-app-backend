import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramDigestService } from './telegram-digest.service';
import { TelegramNotifier } from './telegram.notifier';
import { TelegramService } from './telegram.service';

@Module({
  controllers: [TelegramController],
  providers: [TelegramService, TelegramNotifier, TelegramDigestService],
  exports: [TelegramService, TelegramNotifier],
})
export class TelegramModule {}
