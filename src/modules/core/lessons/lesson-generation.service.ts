import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { DayOfWeek } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LessonsService } from './lessons.service';
import { UpdateGenerationSettingsDto } from './dto/update-generation-settings.dto';
import { BUSINESS_TIMEZONE } from '../../common/business-time';

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
    return this.prisma.$transaction(async (tx) => {
      const settings = await tx.lessonGenerationSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, ...dto },
        update: dto,
      });
      await this.audit.record(
        {
          action: 'lesson_generation_settings.updated',
          entityType: 'LessonGenerationSettings',
          entityId: SETTINGS_ID,
          details: { ...dto },
        },
        tx,
      );
      return settings;
    });
  }

  // Ежедневно проверяем настройки; генерим только в выбранный день недели
  /** Запускает генерацию занятий в настроенный день недели (ежедневный cron). */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: BUSINESS_TIMEZONE })
  async runScheduled() {
    const settings = await this.getSettings();
    if (!settings.enabled) return;

    const today = DateTime.now().setZone(BUSINESS_TIMEZONE);
    if (WEEKDAY[today.weekday % 7] !== settings.triggerDay) return;

    const dateFrom = today.startOf('day');
    const dateTo = dateFrom.plus({ days: settings.daysAhead }).endOf('day');

    const { count } = await this.lessonsService.generate({
      dateFrom: dateFrom.toUTC().toISO()!,
      dateTo: dateTo.toUTC().toISO()!,
    });
    this.logger.log(
      `Автогенерация занятий: создано ${count} (${settings.daysAhead} дн. вперёд)`,
    );
  }
}
