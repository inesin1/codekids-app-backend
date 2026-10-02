import { Role } from '../../../generated/client';
import { LessonsService } from './lessons.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

describe('ReportsController.findByLessonId', () => {
  let controller: ReportsController;
  let lessons: { assertUserCanView: jest.Mock };
  let reports: { findByLessonId: jest.Mock };

  beforeEach(() => {
    lessons = { assertUserCanView: jest.fn() };
    reports = { findByLessonId: jest.fn().mockResolvedValue({}) };
    controller = new ReportsController(
      reports as unknown as ReportsService,
      lessons as unknown as LessonsService,
    );
  });

  it.each([
    [[Role.STUDENT], true],
    [[Role.TEACHER, Role.STUDENT], false],
    [[Role.MANAGER, Role.STUDENT], false],
  ])(
    'hides internal notes according to effective access %s',
    async (roles, hide) => {
      const user = { id: 'u1', roles: roles as Role[] };

      await controller.findByLessonId(
        { user } as unknown as Express.Request,
        'lesson-1',
      );

      expect(lessons.assertUserCanView).toHaveBeenCalledWith('lesson-1', user);
      expect(reports.findByLessonId).toHaveBeenCalledWith('lesson-1', hide);
    },
  );
});
