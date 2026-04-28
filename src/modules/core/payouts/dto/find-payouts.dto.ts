import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { PayoutStatus } from '../../../../generated/client';

export class FindPayoutsDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}
