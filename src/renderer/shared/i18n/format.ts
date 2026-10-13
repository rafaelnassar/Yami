/**
 * Locale-aware display formatters (Intl based). Pure; no React.
 */
import type { Locale } from '../../../shared/contracts/app-settings.ts';

const LOCALE_TAGS: Readonly<Record<Locale, string>> = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };

/** BCP-47 tag used for Intl APIs and `<html lang>`. */
export function localeTag(locale: Locale): string {
  return LOCALE_TAGS[locale];
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Formatters {
  readonly locale: Locale;
  bytes(bytes: number | null | undefined): string;
  number(value: number): string;
  percent(value: number): string;
  /** "5 min ago" style for recent timestamps; a short date after a day. */
  relativeTime(ts: number, now?: number): string;
  /** Sidebar style: time today, "yesterday", otherwise day + short month. */
  conversationDate(ts: number, now?: number): string;
  time(ts: number): string;
  dateTime(ts: number): string;
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

export function createFormatters(locale: Locale): Formatters {
  const tag = localeTag(locale);
  const numberFormat = new Intl.NumberFormat(tag);
  const percentFormat = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
  const relative = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
  const shortDate = new Intl.DateTimeFormat(tag, { day: '2-digit', month: 'short' });
  const fullDate = new Intl.DateTimeFormat(tag, { day: '2-digit', month: 'short', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
  const timeWithSeconds = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTimeFormat = new Intl.DateTimeFormat(tag, { dateStyle: 'short', timeStyle: 'short' });
  const byteFormats = BYTE_UNITS.map(
    (unit) =>
      new Intl.NumberFormat(tag, {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        maximumFractionDigits: unit === 'byte' ? 0 : 1
      })
  );

  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  return {
    locale,
    bytes(bytes) {
      if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
      }
      // Intl's "byte" unit is inconsistent across locales ("512 byte", "512 bytes", "512 B"); the symbol is universal.
      if (unit === 0) return `${numberFormat.format(Math.round(value))} B`;
      return (byteFormats[unit] ?? numberFormat).format(value);
    },
    number: (value) => numberFormat.format(value),
    percent: (value) => percentFormat.format(Math.min(100, Math.max(0, value)) / 100),
    relativeTime(ts, now = Date.now()) {
      const diff = ts - now;
      const abs = Math.abs(diff);
      if (abs < MINUTE) return relative.format(Math.round(diff / SECOND), 'second');
      if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), 'minute');
      if (abs < DAY) return relative.format(Math.round(diff / HOUR), 'hour');
      const date = new Date(ts);
      return new Date(now).getFullYear() === date.getFullYear() ? shortDate.format(date) : fullDate.format(date);
    },
    conversationDate(ts, now = Date.now()) {
      const date = new Date(ts);
      const today = new Date(now);
      if (sameDay(date, today)) return timeFormat.format(date);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (sameDay(date, yesterday)) return relative.format(-1, 'day');
      return today.getFullYear() === date.getFullYear() ? shortDate.format(date) : fullDate.format(date);
    },
    time: (ts) => timeWithSeconds.format(new Date(ts)),
    dateTime: (ts) => dateTimeFormat.format(new Date(ts))
  };
}

/** `m:ss` / `h:mm:ss` media clock (locale-independent digits). */
export function formatMediaTime(seconds: number, padMinutes = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return padMinutes ? '00:00' : '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${two(minutes)}:${two(secs)}`;
  return `${padMinutes ? two(minutes) : minutes}:${two(secs)}`;
}

/** Keeps the start and the end of long strings (file names, paths). */
export function truncateMiddle(value: string, maxLength = 50): string {
  if (!value || value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
