import { PartialType, OmitType } from '@nestjs/mapped-types';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Role } from '../../../../generated/client';
import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password', 'login']),
) {
  @IsOptional()
  @IsString()
  @MaxLength(254)
  login?: string | null;

  @ValidateIf((o: UpdateUserDto) => o.isActive !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((o: UpdateUserDto) => o.roles !== undefined)
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn([Role.ADMIN, Role.MANAGER, Role.TEACHER], { each: true })
  roles?: Role[];

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @MinLength(8)
  password?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(201)
  parentName?: string;
}
