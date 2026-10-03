import { IsEnum, IsOptional, IsString } from 'class-validator';
import { RescheduleRequestStatus } from '../../../../generated/client';
import { PaginationQueryDto } from '../../../common/pagination';

export class FindRescheduleRequestsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(RescheduleRequestStatus)
  status?: RescheduleRequestStatus;

  @IsOptional()
  @IsString()
  lessonId?: string;
}
