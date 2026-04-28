import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListStudentsQueryDto extends ListUsersQueryDto {
  @IsOptional()
  @IsString()
  teacherId?: string;
}
