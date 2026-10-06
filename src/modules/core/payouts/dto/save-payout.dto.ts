import { IsString, Matches } from 'class-validator';
import { CalculatePayoutDto } from './calculate-payout.dto';

export class SavePayoutDto extends CalculatePayoutDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  previewToken: string;
}
