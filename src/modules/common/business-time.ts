import { DateTime } from 'luxon';
import { isIP } from 'node:net';

export const BUSINESS_TIMEZONE =
  process.env.BUSINESS_TIMEZONE || 'Europe/Moscow';

if (!DateTime.now().setZone(BUSINESS_TIMEZONE).isValid) {
  throw new Error(`Invalid BUSINESS_TIMEZONE: ${BUSINESS_TIMEZONE}`);
}

export function businessDayBounds(from: string, to: string) {
  const start = DateTime.fromISO(from, { zone: BUSINESS_TIMEZONE }).startOf(
    'day',
  );
  const end = DateTime.fromISO(to, { zone: BUSINESS_TIMEZONE }).endOf('day');
  if (
    !start.isValid ||
    !end.isValid ||
    end < start ||
    end.diff(start, 'days').days >= 93
  ) {
    throw new RangeError('date range must cover at most 93 days');
  }
  return { gte: start.toJSDate(), lte: end.toJSDate() };
}

export function parseTrustedProxies(value = ''): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, prefix, ...extra] = entry.split('/');
      const family = isIP(address);
      if (
        !family ||
        extra.length ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
      ) {
        throw new Error(`Invalid TRUSTED_PROXIES entry: ${entry}`);
      }
      return entry;
    });
}
