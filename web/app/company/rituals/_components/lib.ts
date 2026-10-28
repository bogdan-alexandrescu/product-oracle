import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { displayZone, formatInZone } from "@/lib/dates";
import { formatDate, zoneName } from "@/lib/format";
import { displayName } from "@/lib/names";
import { ZONE_NOT_SET } from "@/lib/zone";

export type Ritual = Schemas["RitualOut"];
export type Occurrence = Schemas["OccurrenceOut"];
export type OccurrenceSummary = Schemas["OccurrenceSummary"];
/** A stored schedule: the rule people set, in the Company time zone (a ritual has no zone of its own). */
export type Schedule = Schemas["RitualSchedule"] & { timezone: string };
export type Member = Schemas["MemberOut"];
export type Person = Schemas["PersonOut"];
export type SummarySettings = Schemas["SummarySettingsOut"];

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKS: { value: number; label: string }[] = [
  { value: 1, label: "First" },
  { value: 2, label: "Second" },
  { value: 3, label: "Third" },
  { value: 4, label: "Fourth" },
  { value: -1, label: "Last" },
];

/** The schedule picker's presets: Every week on…, Every 2 weeks on…, Monthly…, Every quarter…, Every year in…, Every N weeks. */
export type Preset = "weekly" | "every_2_weeks" | "monthly" | "quarterly" | "yearly" | "every_n_weeks";
export const PRESETS: { value: Preset; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "every_2_weeks", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Every quarter" },
  { value: "yearly", label: "Every year" },
  { value: "every_n_weeks", label: "Every N weeks" },
];

export function presetOf(s: Schedule): Preset {
  if (s.freq === "every_n_weeks") return s.interval === 2 ? "every_2_weeks" : "every_n_weeks";
  return s.freq;
}

/** A complete schedule from the API's stored dict (its defaults filled in). */
export function scheduleOf(raw: Ritual["schedule"]): Schedule {
  return { freq: "weekly", interval: 1, weekday: 0, week_of_month: 1, month: 1, time: "09:00", timezone: "America/Los_Angeles", ...(raw as Partial<Schedule>) };
}

/** The zone's short name for a time that repeats: "PT" (not PST or PDT), else "GMT+9". */
export function zoneShort(zone: string): string {
  const parts = formatInZone(new Date().toISOString(), zone, { timeZoneName: "shortGeneric" }).split(", ");
  return parts[parts.length - 1] ?? zone;
}

/** "9:00 AM" from "09:00", "4:00 PM" from "16:00": the format every other time on the page has (qa-company-25). */
function clockOnly(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
/** The Time picker's choices, every 15 minutes in the page's format ("9:00 AM"), with a stored time off the grid kept. */
export function timeOptions(current: string): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const value = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    out.push({ value, label: clockOnly(value) });
  }
  if (/^\d{2}:\d{2}$/.test(current) && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: clockOnly(current) });
    out.sort((a, b) => a.value.localeCompare(b.value));
  }
  return out;
}
const plural = (day: string) => `${day}s`;

/** When the ritual meets, in the Company time zone: "Mondays 9:00 AM PT", "First Tuesday of the month, 10:00 AM PT". */
export function whenText(s: Schedule): string {
  const clock = (t: string) => `${clockOnly(t)} ${zoneShort(s.timezone)}`;
  const day = WEEKDAYS[s.weekday] ?? "Monday";
  const nth = WEEKS.find((w) => w.value === s.week_of_month)?.label ?? "First";
  switch (s.freq) {
    case "weekly":
      return `${plural(day)} ${clock(s.time)}`;
    case "every_n_weeks":
      return `Every ${s.interval} weeks, ${day} ${clock(s.time)}`;
    case "monthly":
      return `${nth} ${day} of the month, ${clock(s.time)}`;
    case "quarterly":
      return `${nth} ${day} of each quarter, ${clock(s.time)}`;
    case "yearly":
      return `${nth} ${day} of ${MONTHS[s.month - 1]}, ${clock(s.time)}`;
  }
}

const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** A due time in the Company time zone: "Fri, Oct 30, 12:00 PM PDT". */
export const localTime = (iso: string) => formatInZone(iso, displayZone(), WHEN);
export const localDate = formatDate;

/** The same instant in the ritual's own zone (it is scheduled there), for the tooltip. */
export const zoneTime = (iso: string, timezone: string) => `${formatInZone(iso, timezone, WHEN)} (${zoneName(timezone)})`;

/**
 * The Company time zone in words (qa-company-23/24): "Pacific Time (Los Angeles)"; when no
 * owner chose one yet, it says so and names the default used meanwhile, as Home's set-up does.
 */
export const zoneText = (zone: string, isDefault: boolean) => (isDefault ? ZONE_NOT_SET : zoneName(zone));

export const STATE_LABEL: Record<OccurrenceSummary["status"], string> = {
  scheduled: "Scheduled",
  ready: "Ready",
  held: "Held",
  skipped: "Skipped",
  missed: "Missed",
  failed: "Failed",
};
export const STATE_KIND: Record<OccurrenceSummary["status"], ChipKind> = {
  scheduled: "line",
  ready: "acc",
  held: "pass",
  skipped: "na",
  missed: "warn",
  failed: "crit",
};

const summaries = (n: number) => `${n} ${n === 1 ? "summary" : "summaries"}`;

/** "About $17 a month (6 summaries)"; on demand, what Every pre-read would cost (qa-company-27). */
export function estimateText(s: SummarySettings): string {
  const usd = `$${Math.round(s.estimate.usd_per_month)}`;
  const n = Math.round(s.estimate.runs_per_month);
  if (s.mode === "on_demand") return `Every pre-read would cost about ${usd} a month (about ${summaries(n)})`;
  return `About ${usd} a month (${summaries(n)})`;
}

/** A ritual's summaries in whole numbers: "about 4 a month", "about 1 every 3 months", "about 1 a year". */
export function perMonthText(runs: number): string {
  if (runs >= 0.95) return `about ${Math.round(runs)} a month`;
  if (runs <= 0) return "none";
  const months = Math.round(1 / runs);
  return months >= 12 ? "about 1 a year" : `about 1 every ${months} months`;
}

/** A person's name from the member directory (GET /v1/people), which every member may read. */
export const personName = (people: Person[] | undefined, id: string) => people?.find((p) => p.user_id === id)?.name ?? "—";

/** A person's email from the member directory, shown beside the name (qa-company-28). */
export const personEmail = (people: Person[] | undefined, id: string) => people?.find((p) => p.user_id === id)?.email;

/** A member's name as everywhere else (lib/names.ts), the email kept for second. */
export const memberName = (m: Member) => displayName(m.email, m.name);

/** The rule alone, as the API takes it: the ritual is in the Company time zone. */
export function ruleOf(s: Schedule): Schemas["RitualSchedule"] {
  return { freq: s.freq, interval: s.interval, weekday: s.weekday, week_of_month: s.week_of_month, month: s.month, time: s.time };
}
