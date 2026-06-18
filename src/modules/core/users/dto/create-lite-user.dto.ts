import { IsEmail, IsString, MaxLength, ValidateIf } from 'class-validator';
import { PersonFieldsDto } from './person-fields.dto';

export class CreateLiteUserDto extends PersonFieldsDto {
  // email и password опциональны, но только парой (both-or-neither)
  @ValidateIf((o: CreateLiteUserDto) => o.email != null || o.password != null)
  @IsEmail()
  email?: string;

  @ValidateIf((o: CreateLiteUserDto) => o.email != null || o.password != null)
  @IsString()
  @MaxLength(128)
  password?: string;
}
