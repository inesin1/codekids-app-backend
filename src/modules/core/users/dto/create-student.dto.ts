import {
  ArrayMaxSize,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateLiteUserDto } from './create-lite-user.dto';
import { ContactDto } from './contact.dto';

export class CreateStudentDto extends CreateLiteUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(201)
  parentName?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  @ArrayMaxSize(30)
  parentContacts?: ContactDto[];

  @IsOptional()
  @IsDateString()
  birthDate?: string;
}
