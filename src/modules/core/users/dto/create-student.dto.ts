import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

export class CreateStudentDto extends CreateUserDto {
  @IsString()
  parentId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  age?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  grade?: string;
}
