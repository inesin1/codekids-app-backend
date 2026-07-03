import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DayOfWeek } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { UpdateGenerationSettingsDto } from './dto/update-generation-settings.dto';

const SETTINGS_ID = 'singleton';

// JS getDay() (0=вс) → DayOfWeek
const WEEKDAY: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

@Injectable()
export class LessonGenerationService {
  private readonly logger = new Logger(LessonGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lessonsService: LessonsService,
    private readonly audit: AuditService,
  ) {}

  getSettings() {
    return this.prisma.lessonGenerationSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async updateSettings(dto: UpdateGenerationSettingsDto) {
    const settings = await this.prisma.lessonGenerationSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...dto },
      update: dto,
    });
    this.audit.log({
      action: 'lesson_generation_settings.updated',
      entityType: 'LessonGenerationSettings',
      entityId: SETTINGS_ID,
      details: { ...dto },
    });
    return settings;
  }

  // Ежедневно проверяем настройки; генерим только в выбранный день недели
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduled() {
    const settings = await this.getSettings();
    if (!settings.enabled) return;

    const now = new Date();
    if (WEEKDAY[now.getDay()] !== settings.triggerDay) return;

    const dateFrom = new Date(now);
    dateFrom.setHours(0, 0, 0, 0);

    const dateTo = new Date(dateFrom);
    dateTo.setDate(dateTo.getDate() + settings.daysAhead);
    dateTo.setHours(23, 59, 59, 999);

    const { count } = await this.lessonsService.generate({
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
    });
    this.logger.log(
      `Автогенерация занятий: создано ${count} (${settings.daysAhead} дн. вперёд)`,
    );
  }
}
