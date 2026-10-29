import { useMe } from "@/lib/me";
import { DEFAULT_ZONE, displayZone } from "@/lib/zone";

export { DEFAULT_ZONE, displayZone };

/**
 * Display dates and times (#401): every one a person sees is in the Company time zone
 * (Settings › Company, America/Los_Angeles until an owner sets one), labelled with the
 * zone's short name ("PDT") where a time shows. Machine values sent to the API stay
 * ISO/UTC; a picked day is sent as the day, or as an instant made with `zoneInstant`.
 * #447: lib/format.ts's formatters come here too, in `displayZone()`; nothing else in
 * display code formats a date (npm run lint).
 */

/** The Company time zone, as GET /v1/me gives it to every member. */
export function useCompanyZone(): string {
  return useMe().me?.company_timezone || DEFAULT_ZONE;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(locale: string, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: DEFAULT_ZONE });
    }
    cache.set(key, f);
  }
  return f;
}

/**
 * A European zone's short name where en-US only has an offset: "CET" for Europe/Berlin, not
 * "GMT+1", so a time reads as the zone Settings names (Central European Time; the API's
 * company_time.in_words says "CET" too). Other zones keep what en-US gives (qa-onboarding-38).
 */
function namedZone(text: string, zone: string, at: Date): string {
  const offset = /GMT[+-]\d{1,2}(?::\d{2})?/.exec(text);
  if (!offset || !zone.startsWith("Europe/")) return text;
  const name = fmt("en-GB", zone, { hour: "numeric", timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return name && /^[A-Z]{3,5}$/.test(name) ? text.replace(offset[0], name) : text;
}

/** `iso` (an instant) in `zone`, with the zone's short name when the options show a time. */
export function formatInZone(iso: string, zone: string, opts: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const timed = opts.hour !== undefined || opts.minute !== undefined;
  const out = fmt(locale, zone, timed ? { ...opts, timeZoneName: "short" } : opts).format(at);
  return timed ? namedZone(out, zone, at) : out;
}

/** "Oct 16": the day of an instant in `zone`. */
export const zoneDay = (iso: string, zone: string) => formatInZone(iso, zone, { month: "short", day: "numeric" });

/** "Fri, Oct 16". */
export const zoneWeekday = (iso: string, zone: string) => formatInZone(iso, zone, { weekday: "short", month: "short", day: "numeric" });

/** "Oct 19, 8:00 AM PDT". */
export const zoneDateTime = (iso: string, zone: string) =>
  formatInZone(iso, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ at /, ", ");

/** "09:00 PDT" (24-hour). */
export const zoneTime = (iso: string, zone: string) => formatInZone(iso, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "en-GB");

/** The calendar day (YYYY-MM-DD) of an instant in `zone`. */
export function dayIn(at: Date | number | string, zone: string): string {
  const parts = fmt("en-CA", zone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const n = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${n("year")}-${n("month")}-${n("day")}`;
}

/** Today in `zone`, as YYYY-MM-DD. */
export const todayIn = (zone: string, now: number = Date.now()) => dayIn(now, zone);

/** `day` (YYYY-MM-DD) plus `n` days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** `day` (YYYY-MM-DD) plus `n` calendar months; the month's last day when it is shorter (Aug 31 less 6 months is Feb 28). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

/** The ISO instant of `time` (HH:MM) on `day` (YYYY-MM-DD) in `zone`: what the API receives for a picked day. */
export function zoneInstant(day: string, time: string, zone: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // The zone's offset at that wall time, found by formatting the guess (twice, for DST edges).
  let at = wall;
  for (let i = 0; i < 2; i++) at = wall - offset(at, zone);
  return new Date(at).toISOString();
}

function offset(at: number, zone: string): number {
  const parts = fmt("en-US", zone, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

/**
 * A calendar day (YYYY-MM-DD, no time: a milestone, a picked From) as "Sep 1": the same
 * day in every zone, so it is formatted as written.
 */
export function calendarDay(day: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }, locale = "en-US"): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : fmt(locale, "UTC", opts).format(d);
}

/** A calendar day with no zone: "2026-10-14", or a wall time such as "2026-10-14T12:00:00". */
const NAIVE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+)?$/;

/**
 * The day of `value` in the Company time zone: an instant's day there, or a calendar day
 * (no zone given) as written.
 */
export function shownDay(value: string, opts: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  return NAIVE.test(value) ? calendarDay(value, opts, locale) : formatInZone(value, displayZone(), opts, locale);
}

/** "Sun Oct 25, 2:59 PM PDT": a moment in `zone` with its weekday, as the API words a refusal (api/oracle/company_time.py in_words). */
export function inWords(iso: string, zone: string): string {
  try {
    const parts = fmt("en-US", zone, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).formatToParts(new Date(iso));
    const v = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
    return namedZone(`${v("weekday")} ${v("month")} ${v("day")}, ${v("hour")}:${v("minute")} ${v("dayPeriod")} ${v("timeZoneName")}`, zone, new Date(iso));
  } catch {
    return zoneDateTime(iso, zone);
  }
}
