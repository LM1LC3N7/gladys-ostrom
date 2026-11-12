// -----------------------------------------------------------------------------
// Local time of Germany (Europe/Berlin), through the time zone database of
// Node (Intl): the changes of time are the real ones. The Ostrom API speaks
// UTC instants ("2026-11-11T15:00:00.000Z"); the days read (yesterday,
// tomorrow, the backfill) are German days. Pure functions.
// -----------------------------------------------------------------------------

import { DAY, HOUR, TIME_ZONE } from './constants.js';

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The local date and time of Germany at `ms`: { y, mo, d, h, mi, s }. */
export function berlin(ms) {
  const out = {};
  for (const { type, value } of parts.formatToParts(new Date(ms))) {
    out[type] = Number(value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

const pad = (v) => String(v).padStart(2, '0');

/** "2026-11-11", the local date of Germany at `ms`. */
export function localDate(ms) {
  const t = berlin(ms);
  return `${t.y}-${pad(t.mo)}-${pad(t.d)}`;
}

/** Seconds since the local midnight of Germany at `ms` (a wall time, 0..86399). */
export function secondsOfDay(ms) {
  const t = berlin(ms);
  return t.h * 3600 + t.mi * 60 + t.s;
}

/** "14:05", local time of Germany. */
export function clock(ms) {
  const t = berlin(ms);
  return `${pad(t.h)}:${pad(t.mi)}`;
}

/** The instant of a local time of Germany (the first one of an hour seen twice). */
export function fromBerlin(y, mo, d, h = 0, mi = 0) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  for (const offset of [2, 1]) {
    const candidate = asUtc - offset * HOUR;
    const t = berlin(candidate);
    if (t.y === y && t.mo === mo && t.d === d && t.h === h && t.mi === mi) {
      return candidate;
    }
  }
  // A local time skipped by the spring change (02:xx): read as winter time.
  return asUtc - HOUR;
}

/** The local midnight of Germany that starts the day of `ms`. */
export function startOfDay(ms) {
  const t = berlin(ms);
  return fromBerlin(t.y, t.mo, t.d);
}

/** The local midnight `days` days before (negative) or after the day of `ms`. */
export function addDays(ms, days) {
  const t = berlin(ms);
  // Noon of the day, moved by whole days, never lands on a change of time.
  const noon = Date.UTC(t.y, t.mo - 1, t.d, 12) + days * DAY;
  const n = new Date(noon);
  return fromBerlin(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

/** An ISO instant WITH its offset (or Z) -> ms; undefined otherwise (never a guessed zone). */
export function parseInstant(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
