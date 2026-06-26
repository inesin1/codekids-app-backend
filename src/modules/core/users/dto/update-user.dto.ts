import { PartialType, OmitType } from '@nestjs/mapped-types';
import {
  ArrayNotEmpty,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
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

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  // Выдача доступа в ЛК lite-юзеру: пароль ставится только парой с email.
  @ValidateIf((o: UpdateUserDto) => o.password != null)
  @IsString()
  @MaxLength(128)
  password?: string;
}
