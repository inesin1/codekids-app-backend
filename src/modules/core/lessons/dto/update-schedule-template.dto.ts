import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateScheduleTemplateDto } from './create-schedule-template.dto';

export class UpdateScheduleTemplateDto extends PartialType(
  OmitType(CreateScheduleTemplateDto, [
    'enrollmentId',
    'teacherId',
    'studentId',
  ]),
) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
