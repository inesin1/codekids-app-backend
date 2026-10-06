import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEnrollmentDto } from '../../enrollments/dto/create-enrollment.dto';
import { CreateLessonDto } from './create-lesson.dto';
import { UpdateLessonDto } from './update-lesson.dto';

describe('meeting URL DTO validation', () => {
  it('accepts HTTPS links and rejects non-HTTPS links for enrollment and lesson fields', async () => {
    const cases = [
      {
        dto: CreateEnrollmentDto,
        field: 'meetingUrl',
        valid: {
          teacherId: 'teacher-1',
          studentId: 'student-1',
          courseId: 'course-1',
          lessonPrice: 100,
          teacherRate: 50,
        },
      },
      {
        dto: CreateLessonDto,
        field: 'meetingUrlOverride',
        valid: {
          enrollmentId: 'enrollment-1',
          scheduledAt: '2026-10-06T10:00:00Z',
        },
      },
      { dto: UpdateLessonDto, field: 'meetingUrlOverride', valid: {} },
    ];

    for (const { dto, field, valid } of cases) {
      const httpsDto = plainToInstance(dto, {
        ...valid,
        [field]: 'https://meet.example.test/class',
      });
      const httpDto = plainToInstance(dto, {
        ...valid,
        [field]: 'http://meet.example.test/class',
      });
      const inheritedDto = plainToInstance(dto, { ...valid, [field]: null });

      expect(
        (await validate(httpsDto)).some((error) => error.property === field),
      ).toBe(false);
      expect(
        (await validate(httpDto)).some((error) => error.property === field),
      ).toBe(true);
      expect(
        (await validate(inheritedDto)).some(
          (error) => error.property === field,
        ),
      ).toBe(false);
    }
  });
});
