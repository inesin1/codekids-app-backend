import { Role } from '../../../generated/client';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import { LessonsController } from './lessons.controller';

describe('LessonsController student home', () => {
  it('is student-only and derives the student id from the authenticated user', async () => {
    const findStudentHome = jest.fn().mockResolvedValue({
      nextLesson: null,
      latestCompletedLesson: null,
    });
    const controller = new LessonsController(
      { findStudentHome } as never,
      {} as never,
    );

    expect(
      Reflect.getMetadata(ROLES_KEY, LessonsController.prototype.studentHome),
    ).toEqual([Role.STUDENT]);
    await controller.studentHome({ user: { id: 'student-1' } } as never);

    expect(findStudentHome).toHaveBeenCalledWith('student-1');
  });
});
