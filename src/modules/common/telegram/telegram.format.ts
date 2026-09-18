import { DateTime } from 'luxon';
import { Prisma } from '../../../generated/client';

/** Экранирует спецсимволы HTML для отправки в Telegram. */
export const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Обрезает строку до экранирования HTML, чтобы не разорвать сущности. */
export const clip = (s: string, max: number) =>
  esc(s.length > max ? `${s.slice(0, max)}…` : s);

/** Форматирует полное имя пользователя. */
export const fullName = (u: { firstName: string; lastName: string }) =>
  esc(`${u.firstName} ${u.lastName}`);

/** Форматирует дату со временем по Москве. */
export const formatDateTime = (d: Date) =>
  DateTime.fromJSDate(d, { zone: 'Europe/Moscow' })
    .setLocale('ru')
    .toFormat('d MMMM, HH:mm');

/** Форматирует дату по Москве. */
export const formatDate = (d: Date) =>
  DateTime.fromJSDate(d, { zone: 'Europe/Moscow' })
    .setLocale('ru')
    .toFormat('d MMMM yyyy');

/** Форматирует сумму в рублях. */
export const money = (v: Prisma.Decimal | number) =>
  `${Number(v).toLocaleString('ru-RU')} ₽`;
