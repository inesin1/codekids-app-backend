import { IsDateString } from 'class-validator';

export class CalculateAllPayoutsDto {
  @IsDateString()
  periodStart: string;

  @IsDateString()
  periodEnd: string;
}
