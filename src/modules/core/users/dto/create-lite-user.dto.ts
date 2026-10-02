import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PersonFieldsDto } from './person-fields.dto';

export class CreateLiteUserDto extends PersonFieldsDto {
  // login и password задаются только парой (both-or-neither)
  @ValidateIf((o: CreateLiteUserDto) => o.login != null || o.password != null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  login?: string;

  @ValidateIf((o: CreateLiteUserDto) => o.login != null || o.password != null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @MinLength(8)
  password?: string;
}
