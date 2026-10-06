import { ForbiddenException } from '@nestjs/common';
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

describe('UsersController.getAvatar', () => {
  it('allows the owner to load their own avatar', async () => {
    const findAvatar = jest.fn().mockResolvedValue({
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]),
    });
    const controller = new UsersController({
      findAvatar,
    } as unknown as UsersService);

    await controller.getAvatar(
      { user: { id: 'student-1', roles: [Role.STUDENT] } } as never,
      'student-1',
    );

    expect(findAvatar).toHaveBeenCalledWith('student-1');
  });

  it('rejects access to another user before loading the image', async () => {
    const findAvatar = jest.fn();
    const controller = new UsersController({
      findAvatar,
    } as unknown as UsersService);

    await expect(
      controller.getAvatar(
        { user: { id: 'student-1', roles: [Role.STUDENT] } } as never,
        'student-2',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findAvatar).not.toHaveBeenCalled();
  });

  it('allows staff to view an avatar and returns its image bytes', async () => {
    const findAvatar = jest.fn().mockResolvedValue({
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]),
    });
    const controller = new UsersController({
      findAvatar,
    } as unknown as UsersService);

    const response = await controller.getAvatar(
      { user: { id: 'manager-1', roles: [Role.MANAGER] } } as never,
      'student-2',
    );

    expect(findAvatar).toHaveBeenCalledWith('student-2');
    expect(response.getStream()).toBeDefined();
  });
});

describe('UsersController.uploadAvatar', () => {
  it('saves the avatar for the authenticated account', async () => {
    const uploadAvatar = jest
      .fn()
      .mockResolvedValue({ avatarUrl: '/users/user-1/avatar' });
    const controller = new UsersController({
      uploadAvatar,
    } as unknown as UsersService);
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await controller.uploadAvatar(
      { user: { id: 'user-1', roles: [Role.STUDENT] } } as never,
      { buffer },
    );

    expect(uploadAvatar).toHaveBeenCalledWith(
      'user-1',
      Uint8Array.from(buffer),
    );
  });
});
