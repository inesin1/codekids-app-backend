import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ToBoolean } from '../../../common/validation/transforms';

export class ListUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  isActive?: boolean;
}

export class ListStudentsQueryDto extends ListUsersQueryDto {
  @IsOptional()
  @IsString()
  teacherId?: string;
}
