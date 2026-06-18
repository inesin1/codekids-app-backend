import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DayOfWeek } from '../../../../generated/client';
import { ToBoolean } from '../../../common/validation/transforms';

export class FindScheduleTemplatesDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsString()
  studentId?: string;

  @IsOptional()
  @IsEnum(DayOfWeek)
  dayOfWeek?: DayOfWeek;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}
