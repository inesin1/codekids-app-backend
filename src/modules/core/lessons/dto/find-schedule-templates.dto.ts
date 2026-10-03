import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DayOfWeek } from '../../../../generated/client';
import { ToBoolean } from '../../../common/validation/transforms';
import { PaginationQueryDto } from '../../../common/pagination';

export class FindScheduleTemplatesDto extends PaginationQueryDto {
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
