import { Role } from '../../../generated/client';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

describe('UsersController.findAllStudents', () => {
  let controller: UsersController;
  let users: { findAllStudents: jest.Mock };

  beforeEach(() => {
    users = { findAllStudents: jest.fn().mockResolvedValue([]) };
    controller = new UsersController(users as unknown as UsersService);
  });

  it('uses the authenticated teacher scope and hides balance regardless of query fields', async () => {
    const query = { teacherId: 'attacker-selected' } as never;
    await controller.findAllStudents(
      { user: { id: 'teacher-1', roles: [Role.TEACHER] } } as never,
      query,
    );

    expect(users.findAllStudents).toHaveBeenCalledWith(
      { teacherId: 'teacher-1' },
      true,
    );
  });

  it('keeps balance available to staff list requests', async () => {
    const query = {} as never;
    await controller.findAllStudents(
      { user: { id: 'manager-1', roles: [Role.MANAGER] } } as never,
      query,
    );

    expect(users.findAllStudents).toHaveBeenCalledWith(query, false);
  });
});
