import { IsDateString, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../pagination';
import { IsDateRangeOrdered } from '../../validation/is-date-range-ordered';

export class FindAuditLogsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  @IsDateRangeOrdered('from')
  to?: string;
}
