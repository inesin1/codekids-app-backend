import { PartialType, OmitType } from '@nestjs/mapped-types';
import { ArrayNotEmpty, IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Role } from '../../../../generated/client';
import { CreateUserDto } from './create-user.dto';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password']),
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @ArrayNotEmpty()
  @IsIn(Object.values(Role), { each: true })
  roles?: Role[];
}
