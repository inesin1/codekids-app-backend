import { IsOptional, IsString } from 'class-validator';

export class CreateReportDto {
  @IsString()
  topic: string;

  @IsString()
  covered: string;

  @IsString()
  results: string;

  @IsOptional()
  @IsString()
  parentComment?: string;

  @IsOptional()
  @IsString()
  homework?: string;

  @IsOptional()
  @IsString()
  recommendations?: string;

  @IsOptional()
  @IsString()
  extraNotes?: string;
}
