import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ToBoolean } from '../../../common/validation/transforms';

export class FindEnrollmentsDto {
  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsString()
  studentId?: string;

  @IsOptional()
  @IsString()
  courseId?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}
