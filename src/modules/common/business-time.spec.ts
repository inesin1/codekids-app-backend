import { businessDayBounds, parseTrustedProxies } from './business-time';

describe('business day bounds', () => {
  it('uses the configured IANA zone and includes full local calendar days', () => {
    const { gte, lte } = businessDayBounds('2026-01-01', '2026-01-01');
    expect(gte.toISOString()).toBe('2025-12-31T21:00:00.000Z');
    expect(lte.toISOString()).toBe('2026-01-01T20:59:59.999Z');
  });

  it('accepts at most 93 inclusive dates', () => {
    expect(() => businessDayBounds('2026-01-01', '2026-04-03')).not.toThrow();
    expect(() => businessDayBounds('2026-01-01', '2026-04-04')).toThrow(
      RangeError,
    );
  });
});

describe('trusted proxies', () => {
  it('accepts IP and CIDR entries but rejects aliases and malformed ranges', () => {
    expect(parseTrustedProxies('127.0.0.1, 10.0.0.0/8, 2001:db8::/32')).toEqual(
      ['127.0.0.1', '10.0.0.0/8', '2001:db8::/32'],
    );
    expect(parseTrustedProxies('')).toEqual([]);
    for (const value of [
      'localhost',
      '*',
      '10.0.0.0/33',
      '::1/129',
      '10.0.0.0/nope',
    ]) {
      expect(() => parseTrustedProxies(value)).toThrow();
    }
  });
});
