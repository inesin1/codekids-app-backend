import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateEnrollmentDto } from './create-enrollment.dto';

export class UpdateEnrollmentDto extends PartialType(
  OmitType(CreateEnrollmentDto, ['teacherId', 'studentId']),
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
