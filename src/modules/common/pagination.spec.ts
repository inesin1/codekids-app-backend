import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FindEnrollmentsDto } from '../core/enrollments/dto/find-enrollments.dto';
import { FindLessonsDto } from '../core/lessons/dto/find-lessons.dto';
import { FindPayoutsDto } from '../core/payouts/dto/find-payouts.dto';
import { FindUsersQueryDto } from '../core/users/dto/list-users-query.dto';
import { FindAuditLogsDto } from './audit/dto/find-audit-logs.dto';

describe('bounded list query validation', () => {
  it('defaults to page one and 20 items', () => {
    const query = plainToInstance(FindUsersQueryDto, {});
    expect(validateSync(query)).toHaveLength(0);
    expect(query).toMatchObject({ page: 1, limit: 20 });
  });

  it.each(['invalid', '1.5', '0', '101'])(
    'rejects invalid limit %s',
    (limit) => {
      const query = plainToInstance(
        FindUsersQueryDto,
        { limit },
        { enableImplicitConversion: true },
      );
      expect(validateSync(query).length).toBeGreaterThan(0);
    },
  );

  it('rejects non-literal booleans and accepts both literals', () => {
    for (const isActive of ['yes', '0', '']) {
      expect(() =>
        plainToInstance(
          FindEnrollmentsDto,
          { isActive },
          { enableImplicitConversion: true },
        ),
      ).toThrow();
    }
    for (const isActive of ['true', 'false']) {
      const query = plainToInstance(
        FindEnrollmentsDto,
        { isActive },
        { enableImplicitConversion: true },
      );
      expect(validateSync(query)).toHaveLength(0);
    }
  });

  it('rejects pages that could create oversized database offsets', () => {
    const query = plainToInstance(FindUsersQueryDto, { page: 10_001 });
    expect(validateSync(query).length).toBeGreaterThan(0);
  });

  it('requires ISO date bounds for lessons', () => {
    for (const input of [
      {},
      { dateFrom: '2026-10-01' },
      { dateFrom: 'not-date', dateTo: '2026-10-02' },
    ]) {
      const query = plainToInstance(FindLessonsDto, input, {
        enableImplicitConversion: true,
      });
      expect(validateSync(query).length).toBeGreaterThan(0);
    }
    const query = plainToInstance(FindLessonsDto, {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-02',
    });
    expect(validateSync(query)).toHaveLength(0);
  });

  it('validates single and multi-role filters', () => {
    const query = plainToInstance(FindUsersQueryDto, {
      roles: 'ADMIN,MANAGER',
    });
    expect(validateSync(query)).toHaveLength(0);
    const invalid = plainToInstance(FindUsersQueryDto, {
      roles: 'ADMIN,BOGUS',
    });
    expect(validateSync(invalid).length).toBeGreaterThan(0);
  });

  it('rejects reversed audit and payout ranges', () => {
    const audit = plainToInstance(FindAuditLogsDto, {
      from: '2026-10-02',
      to: '2026-10-01',
    });
    const payout = plainToInstance(FindPayoutsDto, {
      createdAtFrom: '2026-10-02',
      createdAtTo: '2026-10-01',
    });
    expect(validateSync(audit).length).toBeGreaterThan(0);
    expect(validateSync(payout).length).toBeGreaterThan(0);
  });
});
