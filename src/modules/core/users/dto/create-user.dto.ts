import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PersonFieldsDto } from './person-fields.dto';

export class CreateUserDto extends PersonFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  login: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;
}
