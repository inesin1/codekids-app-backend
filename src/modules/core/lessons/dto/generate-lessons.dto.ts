import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
} from 'class-validator';

export class GenerateLessonsDto {
  // нет/пусто → все активные шаблоны
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  templateIds?: string[];

  // ISO, границы включительно
  @IsDateString()
  dateFrom: string;

  @IsDateString()
  dateTo: string;
}
