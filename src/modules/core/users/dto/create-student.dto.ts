import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateLiteUserDto } from './create-lite-user.dto';

export class CreateStudentDto extends CreateLiteUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(201)
  parentName?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;
}
