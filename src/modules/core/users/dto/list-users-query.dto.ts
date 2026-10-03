import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Role } from '../../../../generated/client';
import { ToBoolean } from '../../../common/validation/transforms';
import { PaginationQueryDto } from '../../../common/pagination';

export class ListUsersQueryDto extends PaginationQueryDto {
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

export class FindUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray()
  @IsEnum(Role, { each: true })
  roles?: Role[];
}
