import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AnalyticsJobsService } from './analytics-jobs.service';
import type { AnalyticsQueue, AnalyticsQueueJob } from './analytics.queue';
import type { AnalyticsJobResult } from './analytics.types';

describe('AnalyticsJobsService', () => {
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };
  const service = new AnalyticsJobsService(queue as unknown as AnalyticsQueue);

  beforeEach(() => jest.resetAllMocks());

  it('submits async jobs without paging data into the job payload', async () => {
    queue.add.mockResolvedValue({ id: 'j1' });
    await expect(
      service.submit('lessons', {
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
        teacherId: 't1',
      }),
    ).resolves.toEqual({ jobId: 'j1' });
    expect(queue.add).toHaveBeenCalledWith('generate-report', {
      reportType: 'lessons',
      query: {
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
        teacherId: 't1',
      },
    });
  });

  it.each([
    ['2026-02-30', '2026-03-01'],
    ['2026-10-02', '2026-10-01'],
    ['2026-10-01T00:00:00Z', '2026-10-02'],
  ])(
    'rejects invalid date range %s to %s before queueing',
    async (dateFrom, dateTo) => {
      await expect(
        service.submit('lessons', { dateFrom, dateTo }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('normalizes Bull states and returns progress and completed summary', async () => {
    const job = makeJob('completed', result());
    queue.getJob.mockResolvedValue(job);
    await expect(service.getJobStatus('j1')).resolves.toEqual({
      jobId: 'j1',
      reportType: 'lessons',
      status: 'completed',
      progress: 100,
      summary: result().summary,
      totalItems: 3,
    });

    job.state = 'delayed';
    job.progressValue = 34;
    await expect(service.getJobStatus('j1')).resolves.toMatchObject({
      status: 'waiting',
      progress: 34,
    });
  });

  it('sorts money as exact Decimal values before paginating with stable id ties', async () => {
    const snapshot = result();
    snapshot.data = [
      { id: 'b', price: '10.10' },
      { id: 'c', price: '2.00' },
      { id: 'a', price: '10.1' },
    ];
    queue.getJob.mockResolvedValue(makeJob('completed', snapshot));

    const firstPage = await service.getJobRows('j1', {
      page: 1,
      limit: 2,
      sortBy: 'price',
      sortOrder: 'asc',
    });
    expect(firstPage.data.map((row) => row.id)).toEqual(['c', 'a']);
    expect(firstPage.meta).toMatchObject({
      totalItems: 3,
      currentPage: 1,
      itemsPerPage: 2,
      totalPages: 2,
    });
    const secondPage = await service.getJobRows('j1', {
      page: 2,
      limit: 2,
      sortBy: 'price',
      sortOrder: 'asc',
    });
    expect(secondPage.data.map((row) => row.id)).toEqual(['b']);
  });

  it('preserves Decimal precision and null ordering without mutating the snapshot', async () => {
    const snapshot = result();
    snapshot.data = [
      { id: 'a', price: '9999999999.99' },
      { id: 'missing', price: null },
      { id: 'b', price: '9999999999.98' },
      { id: 'zero', price: '0' },
      { id: 'negative', price: '-0.01' },
    ];
    const originalRows = [...snapshot.data];
    queue.getJob.mockResolvedValue(makeJob('completed', snapshot));
    const rows = await service.getJobRows('j1', {
      page: 1,
      limit: 50,
      sortBy: 'price',
      sortOrder: 'desc',
    });
    expect(rows.data.map((row) => row.id)).toEqual([
      'a',
      'b',
      'zero',
      'negative',
      'missing',
    ]);
    expect(snapshot.data).toEqual(originalRows);
  });

  it('sorts boolean and date columns without enumerating their names', async () => {
    const snapshot = result();
    snapshot.data = [
      {
        id: 'late',
        bonusApplied: true,
        completedAt: '2026-06-20T10:00:00.000Z',
      },
      {
        id: 'early',
        bonusApplied: false,
        completedAt: '2026-06-10T10:00:00.000Z',
      },
    ];
    queue.getJob.mockResolvedValue(makeJob('completed', snapshot));

    const booleans = await service.getJobRows('j1', {
      page: 1,
      limit: 50,
      sortBy: 'bonusApplied',
      sortOrder: 'asc',
    });
    const dates = await service.getJobRows('j1', {
      page: 1,
      limit: 50,
      sortBy: 'completedAt',
      sortOrder: 'asc',
    });

    expect(booleans.data.map((row) => row.id)).toEqual(['early', 'late']);
    expect(dates.data.map((row) => row.id)).toEqual(['early', 'late']);
  });

  it('rejects unsupported report sort fields and returns stored export bytes', async () => {
    queue.getJob.mockResolvedValue(makeJob('completed', result()));
    await expect(
      service.getJobRows('j1', {
        page: 1,
        limit: 50,
        sortBy: 'password',
        sortOrder: 'asc',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getJobExport('j1')).resolves.toMatchObject({
      reportType: 'lessons',
      buffer: Buffer.from('xlsx'),
    });
  });

  it('keeps failed jobs visible with a safe error and returns 404 for missing jobs', async () => {
    queue.getJob.mockResolvedValue(makeJob('failed', undefined));
    await expect(service.getJobStatus('j1')).resolves.toMatchObject({
      status: 'failed',
      error: 'Не удалось сформировать отчет.',
    });
    queue.getJob.mockResolvedValue(null);
    await expect(service.getJobStatus('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('expires a completed snapshot after one hour', async () => {
    const expired = makeJob('completed', result());
    expired.finishedOn = Date.now() - 60 * 60 * 1000;
    queue.getJob.mockResolvedValue(expired);
    await expect(
      service.getJobRows('j1', { page: 1, limit: 50, sortOrder: 'desc' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(expired.removeMock).toHaveBeenCalled();
  });
});

function result(): AnalyticsJobResult {
  return {
    reportType: 'lessons',
    summary: {
      completedLessonCount: 3,
      lessonRevenue: '22.2',
      teacherAccrued: '18.2',
      topUps: null,
    },
    data: [
      { id: 'b', price: '10.10' },
      { id: 'c', price: '2.00' },
      { id: 'a', price: '10.1' },
    ],
    exportBase64: Buffer.from('xlsx').toString('base64'),
  };
}

function makeJob(state: string, returnvalue?: AnalyticsJobResult) {
  const mockJob = {
    id: 'j1',
    data: {
      reportType: 'lessons',
      query: { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
    },
    returnvalue,
    finishedOn: Date.now(),
    state,
    progressValue: state === 'completed' ? 100 : 0,
    getState: jest.fn<Promise<string>, []>(),
    progress: jest.fn<Promise<void> | number, [number?]>(),
    removeMock: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  } as {
    id: string;
    data: { reportType: string; query: { dateFrom: string; dateTo: string } };
    returnvalue?: AnalyticsJobResult;
    finishedOn: number;
    state: string;
    progressValue: number;
    getState: jest.Mock<Promise<string>, []>;
    progress: jest.Mock<Promise<void> | number, [number?]>;
    removeMock: jest.Mock;
    remove: jest.Mock;
  };
  mockJob.getState.mockImplementation(() => Promise.resolve(mockJob.state));
  mockJob.progress.mockImplementation((value?: number) => {
    if (value !== undefined) {
      mockJob.progressValue = value;
      return Promise.resolve();
    }
    return mockJob.progressValue;
  });
  mockJob.remove = mockJob.removeMock;
  return mockJob as unknown as AnalyticsQueueJob & {
    state: string;
    progressValue: number;
    removeMock: jest.Mock;
  };
}
