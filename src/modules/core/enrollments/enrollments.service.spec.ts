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
    expect(JSON.stringify(audit.record.mock.calls[0][0])).not.toContain(
      meetingUrl,
    );
    expect(audit.record.mock.calls[0][0].details).toEqual({
      meetingUrlChanged: true,
    });
  });
});
