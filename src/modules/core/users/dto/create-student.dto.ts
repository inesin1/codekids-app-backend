import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CreateLiteUserDto } from './create-lite-user.dto';

export class CreateStudentDto extends CreateLiteUserDto {
  @IsOptional()
  @IsString()
  parentUserId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  age?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  grade?: string;
}
