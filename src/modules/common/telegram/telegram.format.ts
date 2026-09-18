import { DateTime } from 'luxon';
import { Prisma } from '../../../generated/client';

export const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Лимит сообщения Telegram — 4096 символов; режем свободный текст до экранирования,
// чтобы не разорвать HTML-сущность
export const clip = (s: string, max: number) =>
  esc(s.length > max ? `${s.slice(0, max)}…` : s);

export const fullName = (u: { firstName: string; lastName: string }) =>
  esc(`${u.firstName} ${u.lastName}`);

export const formatDateTime = (d: Date) =>
  DateTime.fromJSDate(d, { zone: 'Europe/Moscow' })
    .setLocale('ru')
    .toFormat('d MMMM, HH:mm');

export const formatDate = (d: Date) =>
  DateTime.fromJSDate(d, { zone: 'Europe/Moscow' })
    .setLocale('ru')
    .toFormat('d MMMM yyyy');

export const money = (v: Prisma.Decimal | number) =>
  `${Number(v).toLocaleString('ru-RU')} ₽`;
