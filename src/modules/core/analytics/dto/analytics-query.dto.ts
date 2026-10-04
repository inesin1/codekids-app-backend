import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { PayoutStatus } from '../../../../generated/client';
import { PaginationQueryDto } from '../../../common/pagination';

export class AnalyticsDateRangeDto extends PaginationQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo!: string;
}

export class LessonsAnalyticsQueryDto extends AnalyticsDateRangeDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsString()
  studentId?: string;
}

export class PayoutsAnalyticsQueryDto extends AnalyticsDateRangeDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;
}
