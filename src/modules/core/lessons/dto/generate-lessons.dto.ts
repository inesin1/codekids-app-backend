import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
} from 'class-validator';

export class GenerateLessonsDto {
  // пустой массив или отсутствие — все активные шаблоны
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  templateIds?: string[];

  @IsDateString()
  dateFrom: string;

  @IsDateString()
  dateTo: string;
}
