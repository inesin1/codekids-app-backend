import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { LessonStatus } from '../../../../generated/client';
import { PaginationQueryDto } from '../../../common/pagination';

export class FindLessonsDto extends PaginationQueryDto {
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo: string;

  @IsOptional()
  @IsEnum(LessonStatus)
  status?: LessonStatus;

  @IsOptional()
  @IsString()
  teacherId?: string;

  @IsOptional()
  @IsString()
  studentId?: string;
}
