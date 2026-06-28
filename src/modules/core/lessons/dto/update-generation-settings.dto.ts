import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { DayOfWeek } from '../../../../generated/client';

export class UpdateGenerationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(DayOfWeek)
  triggerDay?: DayOfWeek;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  daysAhead?: number;
}
