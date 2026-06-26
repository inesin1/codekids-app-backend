import { IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateEnrollmentDto {
  // userId преподавателя (роль TEACHER)
  @IsString()
  teacherId: string;

  // userId ученика (роль STUDENT)
  @IsString()
  studentId: string;

  @IsString()
  courseId: string;

  @IsNumber()
  @IsPositive()
  lessonPrice: number;

  @IsNumber()
  @IsPositive()
  teacherRate: number;
}
