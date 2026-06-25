import {
  ArrayMaxSize,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ContactDto } from './contact.dto';

export class PersonFieldsDto {
  @IsString()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @MaxLength(100)
  lastName: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  telegramChatId?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  @ArrayMaxSize(30)
  contacts?: ContactDto[];
}
