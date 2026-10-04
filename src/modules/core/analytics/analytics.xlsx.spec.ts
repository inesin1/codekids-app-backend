import ExcelJS from 'exceljs';
import { createAnalyticsWorkbook } from './analytics.xlsx';
import type { AnalyticsRow } from './analytics.types';

describe('createAnalyticsWorkbook date handling', () => {
  it('exports lesson dates from Date objects and ISO strings in business time', async () => {
    const summary = {
      completedLessonCount: 2,
      lessonRevenue: '20',
      teacherAccrued: '16',
      topUps: null,
    };
    const data: AnalyticsRow[] = [
      lesson('date', new Date('2026-06-01T09:00:00.000Z')),
      lesson('iso', '2026-06-01T09:00:00.000Z'),
    ];

    const workbook = await loadWorkbook(
      await createAnalyticsWorkbook(
        'lessons',
        summary,
        data,
        '2026-06-01',
        '2026-06-30',
      ),
    );
    const sheet = workbook.getWorksheet('Занятия')!;

    expect(sheet.getCell('A2').value).toEqual(
      businessExcelDate(2026, 6, 1, 12),
    );
    expect(sheet.getCell('A3').value).toEqual(
      businessExcelDate(2026, 6, 1, 12),
    );
  });

  it('exports payout dates and exclusive period ends from Date objects and ISO strings', async () => {
    const summary = {
      payoutCount: 2,
      totalPayout: '20',
      paidPayout: '20',
      pendingPayout: '0',
    };
    const data: AnalyticsRow[] = [
      payout('date', {
        periodStart: new Date('2026-06-30T21:00:00.000Z'),
        periodEnd: new Date('2026-07-31T21:00:00.000Z'),
        paidAt: new Date('2026-07-03T09:15:00.000Z'),
      }),
      payout('iso', {
        periodStart: '2026-06-30T21:00:00.000Z',
        periodEnd: '2026-07-31T21:00:00.000Z',
        paidAt: '2026-07-03T09:15:00.000Z',
      }),
    ];

    const workbook = await loadWorkbook(
      await createAnalyticsWorkbook(
        'payouts',
        summary,
        data,
        '2026-07-01',
        '2026-07-31',
      ),
    );
    const sheet = workbook.getWorksheet('Выплаты')!;

    for (const row of [2, 3]) {
      expect(sheet.getCell(`B${row}`).value).toEqual(
        businessExcelDate(2026, 7, 1),
      );
      expect(sheet.getCell(`C${row}`).value).toEqual(
        businessExcelDate(2026, 7, 31, 23, 59, 59, 999),
      );
      expect(sheet.getCell(`H${row}`).value).toEqual(
        businessExcelDate(2026, 7, 3, 12, 15),
      );
    }
  });
});

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  return workbook;
}

function businessExcelDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
  );
}

function lesson(id: string, completedAt: Date | string) {
  return {
    id,
    completedAt,
    teacherName: 'Teacher',
    studentName: 'Student',
    courseName: 'Math',
    durationMinutes: 60,
    price: '10',
    teacherRate: '8',
    bonusAmount: '0',
  };
}

function payout(
  id: string,
  dates: {
    periodStart: Date | string;
    periodEnd: Date | string;
    paidAt: Date | string;
  },
) {
  return {
    id,
    teacherName: 'Teacher',
    ...dates,
    basePay: '10',
    bonusPay: '0',
    totalPay: '10',
    status: 'PAID',
  };
}
