import { IsDateString, IsString } from 'class-validator';

export class CalculatePayoutDto {
  @IsString()
  teacherId: string;

  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;
}
