import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsEnum,
  IsInt,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '../../../../generated/client';

export class ScheduleTemplateSlotDto {
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'startTime must be in HH:mm format',
  })
  startTime: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  durationMinutes?: number;
}

export class CreateScheduleTemplateDto {
  @IsString()
  enrollmentId: string;

  // userId преподавателя
  @IsString()
  teacherId: string;

  // userId ученика
  @IsString()
  studentId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ScheduleTemplateSlotDto)
  slots: ScheduleTemplateSlotDto[];
}
