import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ContactDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(50)
  label: string;

  @IsString()
  @MaxLength(500)
  value: string;
}
