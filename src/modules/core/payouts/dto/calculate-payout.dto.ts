import { IsDateString, IsString } from 'class-validator';

export class CalculatePayoutDto {
  // userId преподавателя
  @IsString()
  teacherId: string;

  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;
}
