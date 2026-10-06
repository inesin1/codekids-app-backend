import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { PayoutStatus } from '../../../../generated/client';
import { PaginationQueryDto } from '../../../common/pagination';
import { IsDateRangeOrdered } from '../../../common/validation/is-date-range-ordered';

export class FindPayoutsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @IsOptional()
  @IsDateString()
  createdAtFrom?: string;

  @IsOptional()
  @IsDateString()
  @IsDateRangeOrdered('createdAtFrom')
  createdAtTo?: string;
}
