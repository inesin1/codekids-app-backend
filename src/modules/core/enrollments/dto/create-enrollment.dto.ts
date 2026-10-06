import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreateEnrollmentDto {
  @IsString()
  teacherId: string;

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

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  meetingUrl?: string | null;
}
