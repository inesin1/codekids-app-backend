import { Module } from '@nestjs/common';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { ScheduleTemplatesController } from './schedule-templates.controller';
import { ScheduleTemplatesService } from './schedule-templates.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { RescheduleController } from './reschedule.controller';
import { RescheduleService } from './reschedule.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

@Module({
  controllers: [
    LessonsController,
    ScheduleTemplatesController,
    ReportsController,
    RescheduleController,
    MaterialsController,
  ],
  providers: [
    LessonsService,
    ScheduleTemplatesService,
    ReportsService,
    RescheduleService,
    MaterialsService,
  ],
  exports: [LessonsService],
})
export class LessonsModule {}
