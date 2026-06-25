import { IsBoolean, IsOptional } from 'class-validator';
import { ToBoolean } from '../../../common/validation/transforms';

export class FindCoursesDto {
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}
