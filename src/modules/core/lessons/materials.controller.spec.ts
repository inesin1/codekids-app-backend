import { ForbiddenException } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { LessonsService } from './lessons.service';
import { MaterialsController } from './materials.controller';
import { MaterialsService } from './materials.service';

describe('MaterialsController access', () => {
  it('rejects a forbidden download before loading file bytes', async () => {
    const findFile = jest.fn();
    const assertUserCanView = jest
      .fn()
      .mockRejectedValue(new ForbiddenException());
    const controller = new MaterialsController(
      { findFile } as unknown as MaterialsService,
      { assertUserCanView } as unknown as LessonsService,
    );
    const request = {
      user: { id: 'other-student', roles: [Role.STUDENT] },
    } as Express.Request;

    await expect(
      controller.download(request, 'lesson', 'file'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFile).not.toHaveBeenCalled();
  });

  it('passes both lesson and material identifiers when staff removes a file', async () => {
    const remove = jest.fn().mockResolvedValue({ id: 'file' });
    const controller = new MaterialsController(
      { remove } as unknown as MaterialsService,
      {} as LessonsService,
    );
    const request = {
      user: { id: 'admin', roles: [Role.ADMIN] },
    } as Express.Request;

    await controller.remove(request, 'route-lesson', 'file');
    expect(remove).toHaveBeenCalledWith('file', 'route-lesson');
  });
});
