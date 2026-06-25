import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
