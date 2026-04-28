import { IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateEnrollmentDto {
  @IsString()
  teacherId: string;

  @IsString()
  studentId: string;

  @IsNumber()
  @IsPositive()
  lessonPrice: number;

  @IsNumber()
  @IsPositive()
  teacherRate: number;
}
