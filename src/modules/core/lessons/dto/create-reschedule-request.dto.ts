import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { RescheduleRequestType } from '../../../../generated/client';

export class CreateRescheduleRequestDto {
  @IsEnum(RescheduleRequestType)
  type: RescheduleRequestType;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsDateString()
  proposedDate?: string;
}
