import { IsEmail, IsString, MaxLength } from 'class-validator';
import { PersonFieldsDto } from './person-fields.dto';

export class CreateUserDto extends PersonFieldsDto {
  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}
