import { Reflector } from '@nestjs/core';
import { Role } from '../../../generated/client';
import { RolesGuard } from '../../common/auth/guards/roles.guard';
import { AnalyticsController } from './analytics.controller';

describe('AnalyticsController', () => {
  const guard = new RolesGuard(new Reflector());
  const handlers = [
    'createLessonsJob',
    'createPayoutsJob',
    'getJobStatus',
    'getJobRows',
    'downloadJobExport',
  ] as const;

  it.each(handlers)('allows only staff on %s', (method) => {
    const handler = AnalyticsController.prototype[method];
    expect(canActivate(handler, [Role.ADMIN])).toBe(true);
    expect(canActivate(handler, [Role.MANAGER])).toBe(true);
    expect(canActivate(handler, [Role.TEACHER])).toBe(false);
    expect(canActivate(handler, [Role.STUDENT])).toBe(false);
    expect(canActivate(handler, [])).toBe(false);
  });

  it('submits report filters and serves the stored export bytes', async () => {
    const jobs = {
      submit: jest.fn().mockResolvedValue({ jobId: 'j1' }),
      getJobStatus: jest.fn().mockResolvedValue({
        jobId: 'j1',
        reportType: 'lessons',
        status: 'waiting',
        progress: 0,
      }),
      getJobRows: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      getJobExport: jest.fn().mockResolvedValue({
        reportType: 'lessons',
        buffer: Buffer.from('xlsx'),
      }),
    };
    const controller = new AnalyticsController(jobs as never);
    const query = {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      teacherId: 't1',
      page: 1,
      limit: 20,
    };
    const response = { setHeader: jest.fn(), send: jest.fn() };

    expect(await controller.createLessonsJob(query)).toEqual({ jobId: 'j1' });
    expect(jobs.submit).toHaveBeenCalledWith('lessons', query);
    expect(await controller.getJobStatus('j1')).toMatchObject({
      status: 'waiting',
    });
    expect(
      await controller.getJobRows('j1', { page: 1, limit: 50 } as never),
    ).toEqual({ data: [], meta: {} });
    await controller.downloadJobExport('j1', response as never);
    expect(response.send).toHaveBeenCalledWith(Buffer.from('xlsx'));
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="analytics-lessons.xlsx"',
    );
  });

  function canActivate(
    handler: AnalyticsController[(typeof handlers)[number]],
    roles: Role[],
  ) {
    return guard.canActivate({
      getHandler: () => handler,
      getClass: () => AnalyticsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { roles } }),
      }),
    } as never);
  }
});
