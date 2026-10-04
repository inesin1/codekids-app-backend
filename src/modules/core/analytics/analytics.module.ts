import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsJobsService } from './analytics-jobs.service';
import { ANALYTICS_QUEUE_NAME } from './analytics.queue';
import { AnalyticsProcessor } from './analytics.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        url: config.getOrThrow<string>('REDIS_URL'),
      }),
    }),
    BullModule.registerQueue({
      name: ANALYTICS_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 3600 },
      },
    }),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsJobsService, AnalyticsProcessor],
})
export class AnalyticsModule {}
