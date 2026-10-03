import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
  amount: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
