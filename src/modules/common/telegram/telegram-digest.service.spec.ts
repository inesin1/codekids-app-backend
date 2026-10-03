import { TelegramDigestService } from './telegram-digest.service';

describe('TelegramDigestService', () => {
  it('counts each digest category and fetches at most five rows', async () => {
    const lesson = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    const rescheduleRequest = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    const studentProfile = {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    const prisma = {
      lesson,
      rescheduleRequest,
      studentProfile,
      telegramNotification: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new TelegramDigestService(prisma as never, {} as never);

    await expect(
      service.buildText(new Date('2026-10-03T10:00:00Z')),
    ).resolves.toBeNull();
    for (const findMany of [
      lesson.findMany,
      rescheduleRequest.findMany,
      studentProfile.findMany,
    ]) {
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    }
    expect(lesson.count).toHaveBeenCalledTimes(2);
    expect(rescheduleRequest.count).toHaveBeenCalledTimes(1);
    expect(studentProfile.count).toHaveBeenCalledTimes(2);
  });
});
