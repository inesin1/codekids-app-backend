import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentsService } from './enrollments.service';

describe('EnrollmentsService', () => {
  it('persists meeting links without writing their value to the audit log', async () => {
    const meetingUrl = 'https://meet.example.com/group';
    const tx = {
      enrollment: {
        update: jest.fn().mockResolvedValue({ id: 'enrollment-1', meetingUrl }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (db: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new EnrollmentsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );

    await service.update('enrollment-1', { meetingUrl });

    expect(tx.enrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'enrollment-1' },
        data: { meetingUrl },
      }),
    );
    const auditCalls = audit.record.mock.calls as unknown as [
      [Parameters<AuditService['record']>[0]],
    ];
    const auditEntry = auditCalls[0][0];
    expect(JSON.stringify(auditEntry)).not.toContain(meetingUrl);
    expect(auditEntry.details).toEqual({ meetingUrlChanged: true });
  });
});
