import { IsDateString, IsOptional, IsString } from 'class-validator';
import { CreateLiteUserDto } from './create-lite-user.dto';

export class CreateStudentDto extends CreateLiteUserDto {
  @IsOptional()
  @IsString()
  parentUserId?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;
}
