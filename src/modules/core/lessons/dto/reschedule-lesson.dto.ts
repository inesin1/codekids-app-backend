import { IsDateString } from 'class-validator';

export class RescheduleLessonDto {
  @IsDateString()
  newDate: string;
}
