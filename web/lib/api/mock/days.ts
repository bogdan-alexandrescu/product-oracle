import { calendarDay } from "@/lib/dates";

/**
 * A calendar day in prose ("2026-10-02"), as the API's export reads it (api/oracle/export/render.py
 * _PROSE_DAY): never one inside a key, a slug, a path or a time.
 */
const PROSE_DAY = /(?<![\w./-])(\d{4})-(\d{2})-(\d{2})(?![\w/-]|:\d)/g;

/**
 * Prose with its calendar days month first, as the API's render (days_in_words): "As of 2026-10-02."
 * reads "As of Oct 2, 2026."; a day that is not a real one stays as written. The stored text is not changed.
 */
export function daysInWords(text: string): string {
  return text.replace(PROSE_DAY, (all, y: string, m: string, d: string) => {
    const day = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    const real = day.getUTCFullYear() === Number(y) && day.getUTCMonth() === Number(m) - 1 && day.getUTCDate() === Number(d);
    return real ? calendarDay(all, { month: "short", day: "numeric", year: "numeric" }) : all;
  });
}
