import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ToBoolean } from '../../../common/validation/transforms';
import { PaginationQueryDto } from '../../../common/pagination';

export class FindEnrollmentsDto extends PaginationQueryDto {
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
