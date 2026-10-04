import ExcelJS from 'exceljs';
import { AnalyticsProcessor } from './analytics.processor';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsProcessor', () => {
  it('stores the complete immutable report rows, summary, and workbook in the Bull result', async () => {
    const analytics = {
      exportLessons: jest.fn().mockResolvedValue({
        summary: {
          completedLessonCount: 2,
          lessonRevenue: '20.20',
          teacherAccrued: '16.40',
          topUps: '30.00',
        },
        data: [
          lesson('l1', '10.10', new Date('2026-06-01T09:00:00.000Z')),
          lesson('l2', '10.10'),
        ],
      }),
      exportPayouts: jest.fn(),
    };
    const processor = new AnalyticsProcessor(
      analytics as unknown as AnalyticsService,
    );
    const progress = jest.fn().mockResolvedValue(undefined);
    const job = {
      data: {
        reportType: 'lessons',
        query: { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
      },
      progress,
    } as unknown as Parameters<typeof processor.process>[0];

    const result = await processor.process(job);
    expect(progress).toHaveBeenNthCalledWith(1, 5);
    expect(progress).toHaveBeenNthCalledWith(2, 75);
    expect(progress).toHaveBeenNthCalledWith(3, 100);
    expect(result.data).toHaveLength(2);
    expect(result.summary).toMatchObject({ completedLessonCount: 2 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(result.exportBase64, 'base64') as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    expect(workbook.getWorksheet('Итоги')?.getCell('B3').value).toBe(2);
    expect(workbook.getWorksheet('Занятия')?.rowCount).toBe(3);
    expect(
      workbook.getWorksheet('Занятия')?.getCell('A3').value,
    ).toBeInstanceOf(Date);
  });

  it('stores every payout row and payout summary in the exported workbook', async () => {
    const createPayoutRow = (id: string) => ({
      id,
      teacherId: 'teacher-1',
      teacherName: 'Teacher',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      basePay: '10.10',
      bonusPay: '0.20',
      totalPay: '10.30',
      status: 'PAID',
      paidAt: '2026-07-03T00:00:00.000Z',
    });
    const analytics = {
      exportLessons: jest.fn(),
      exportPayouts: jest.fn().mockResolvedValue({
        summary: {
          payoutCount: 2,
          totalPayout: '20.60',
          paidPayout: '20.60',
          pendingPayout: '0',
        },
        data: [createPayoutRow('p1'), createPayoutRow('p2')],
      }),
    };
    const processor = new AnalyticsProcessor(
      analytics as unknown as AnalyticsService,
    );
    const result = await processor.process({
      data: {
        reportType: 'payouts',
        query: { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
      },
      progress: jest.fn().mockResolvedValue(undefined),
    } as unknown as Parameters<typeof processor.process>[0]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(result.exportBase64, 'base64') as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    expect(result.data).toHaveLength(2);
    expect(workbook.getWorksheet('Итоги')?.getCell('B3').value).toBe(2);
    expect(workbook.getWorksheet('Выплаты')?.rowCount).toBe(3);
    expect(workbook.getWorksheet('Выплаты')?.getCell('F3').value).toBe(10.3);
  });
});

function lesson(
  id: string,
  price: string,
  completedAt: Date | string = '2026-06-01T09:00:00.000Z',
) {
  return {
    id,
    scheduledAt: '2026-06-01T08:00:00.000Z',
    completedAt,
    durationMinutes: 60,
    teacherId: 'teacher-1',
    teacherName: 'Teacher',
    studentId: 'student-1',
    studentName: 'Student',
    price,
    teacherRate: '8.20',
    bonusApplied: false,
    bonusAmount: '0',
    courseName: 'Math',
  };
}
