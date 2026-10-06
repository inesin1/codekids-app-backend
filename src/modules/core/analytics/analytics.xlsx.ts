import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { BUSINESS_TIMEZONE } from '../../common/business-time';
import {
  AnalyticsReportType,
  AnalyticsSummary,
  AnalyticsRow,
} from './analytics.types';

export async function createAnalyticsWorkbook(
  reportType: AnalyticsReportType,
  summaryData: AnalyticsSummary,
  data: AnalyticsRow[],
  dateFrom: string,
  dateTo: string,
  onProgress?: (processedRows: number, totalRows: number) => Promise<void>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const progressBatchSize = Math.max(10, Math.ceil(data.length / 20));
  const summary = workbook.addWorksheet('Итоги');
  summary.columns = [
    { header: 'Показатель', key: 'label', width: 28 },
    { header: 'Значение', key: 'value', width: 22 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.addRow(['Период', [dateFrom, dateTo].join(' — ')]);

  if (reportType === 'lessons') {
    const lessonSummary = summaryData as Extract<
      AnalyticsSummary,
      { topUps: string | null }
    >;
    summary.addRow(['Проведено занятий', lessonSummary.completedLessonCount]);
    summary.addRow(['Выручка занятий', Number(lessonSummary.lessonRevenue)]);
    summary.addRow([
      'Начислено преподавателям',
      Number(lessonSummary.teacherAccrued),
    ]);
    summary.addRow([
      'Пополнения баланса',
      lessonSummary.topUps == null ? '—' : Number(lessonSummary.topUps),
    ]);

    const sheet = workbook.addWorksheet('Занятия');
    sheet.columns = [
      { header: 'Дата занятия', key: 'scheduledAt', width: 24 },
      { header: 'Дата отметки «Проведено»', key: 'completedAt', width: 28 },
      { header: 'Преподаватель', key: 'teacherName', width: 28 },
      { header: 'Ученик', key: 'studentName', width: 28 },
      { header: 'Курс', key: 'courseName', width: 28 },
      { header: 'Длительность, мин', key: 'durationMinutes', width: 20 },
      { header: 'Выручка', key: 'price', width: 16 },
      { header: 'Ставка преподавателя', key: 'teacherRate', width: 22 },
      { header: 'Премия', key: 'bonusAmount', width: 16 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = 'A1:I1';
    sheet.getRow(1).font = { bold: true };
    sheet.getColumn('scheduledAt').numFmt = 'dd.mm.yyyy hh:mm';
    sheet.getColumn('completedAt').numFmt = 'dd.mm.yyyy hh:mm';
    sheet.getColumn('price').numFmt = '#,##0.00';
    sheet.getColumn('teacherRate').numFmt = '#,##0.00';
    sheet.getColumn('bonusAmount').numFmt = '#,##0.00';
    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      sheet.addRow([
        toExcelBusinessTime(row.scheduledAt),
        toExcelBusinessTime(row.completedAt),
        row.teacherName,
        row.studentName,
        row.courseName,
        row.durationMinutes,
        Number(row.price),
        row.teacherRate == null ? '' : Number(row.teacherRate),
        Number(row.bonusAmount),
      ]);
      const processedRows = index + 1;
      if (
        data.length >= progressBatchSize &&
        (processedRows % progressBatchSize === 0 ||
          processedRows === data.length)
      ) {
        await onProgress?.(processedRows, data.length);
      }
    }
  } else {
    const payoutSummary = summaryData as Extract<
      AnalyticsSummary,
      { totalPayout: string }
    >;
    summary.addRow(['Количество выплат', payoutSummary.payoutCount]);
    summary.addRow(['Начислено', Number(payoutSummary.totalPayout)]);
    summary.addRow(['Выплачено', Number(payoutSummary.paidPayout)]);
    summary.addRow(['К выплате', Number(payoutSummary.pendingPayout)]);

    const sheet = workbook.addWorksheet('Выплаты');
    sheet.columns = [
      { header: 'Преподаватель', key: 'teacherName', width: 28 },
      { header: 'Начало периода', key: 'periodStart', width: 24 },
      { header: 'Конец периода', key: 'periodEnd', width: 24 },
      { header: 'Базовая сумма', key: 'basePay', width: 18 },
      { header: 'Премии', key: 'bonusPay', width: 16 },
      { header: 'Итого', key: 'totalPay', width: 16 },
      { header: 'Статус', key: 'status', width: 16 },
      { header: 'Дата выплаты', key: 'paidAt', width: 24 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = 'A1:H1';
    sheet.getRow(1).font = { bold: true };
    sheet.getColumn('periodStart').numFmt = 'dd.mm.yyyy';
    sheet.getColumn('periodEnd').numFmt = 'dd.mm.yyyy';
    sheet.getColumn('basePay').numFmt = '#,##0.00';
    sheet.getColumn('bonusPay').numFmt = '#,##0.00';
    sheet.getColumn('totalPay').numFmt = '#,##0.00';
    sheet.getColumn('paidAt').numFmt = 'dd.mm.yyyy hh:mm';
    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      sheet.addRow([
        row.teacherName,
        toExcelBusinessTime(row.periodStart),
        toExcelBusinessTime(subtractOneMillisecond(row.periodEnd)),
        Number(row.basePay),
        Number(row.bonusPay),
        Number(row.totalPay),
        row.status === 'PAID' ? 'Выплачено' : 'Начислено',
        row.paidAt == null ? null : toExcelBusinessTime(row.paidAt),
      ]);
      const processedRows = index + 1;
      if (
        data.length >= progressBatchSize &&
        (processedRows % progressBatchSize === 0 ||
          processedRows === data.length)
      ) {
        await onProgress?.(processedRows, data.length);
      }
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function toExcelBusinessTime(value: unknown): Date {
  const utc =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: 'utc' })
      : typeof value === 'string'
        ? DateTime.fromISO(value, { zone: 'utc' })
        : null;
  if (!utc?.isValid) {
    throw new RangeError('Analytics workbook contains an invalid date');
  }
  const local = utc.setZone(BUSINESS_TIMEZONE);
  return new Date(
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      local.millisecond,
    ),
  );
}

function subtractOneMillisecond(value: unknown): Date {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new RangeError('Analytics workbook contains an invalid date');
  }
  return new Date(timestamp - 1);
}
