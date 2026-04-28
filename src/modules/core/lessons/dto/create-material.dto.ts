import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';

export class CreateMaterialDto {
  @IsString()
  title: string;

  @IsUrl()
  fileUrl: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;
}
