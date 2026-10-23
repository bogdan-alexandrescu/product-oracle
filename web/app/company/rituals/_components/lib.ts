import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { displayZone, formatInZone } from "@/lib/dates";
import { formatDate } from "@/lib/format";

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

/** "9:00" from "09:00". */
const clock = (t: string) => t.replace(/^0(\d)/, "$1");
const plural = (day: string) => `${day}s`;

/** When the ritual meets, in its own zone: "Mondays 9:00", "First Tuesday of the month, 10:00". */
export function whenText(s: Schedule): string {
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
export const zoneTime = (iso: string, timezone: string) => `${formatInZone(iso, timezone, WHEN)} (${timezone})`;

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

/** "About $17 a month (6 summaries)", "If on: about $17 a month". */
export function estimateText(s: SummarySettings): string {
  const usd = `$${Math.round(s.estimate.usd_per_month)}`;
  if (s.mode === "on_demand") return `If on: about ${usd} a month`;
  const n = Math.round(s.estimate.runs_per_month);
  return `About ${usd} a month (${n} ${n === 1 ? "summary" : "summaries"})`;
}

/** A person's name from the member directory (GET /v1/people), which every member may read. */
export const personName = (people: Person[] | undefined, id: string) => people?.find((p) => p.user_id === id)?.name ?? "—";

/** The rule alone, as the API takes it: the ritual is in the Company time zone. */
export function ruleOf(s: Schedule): Schemas["RitualSchedule"] {
  return { freq: s.freq, interval: s.interval, weekday: s.weekday, week_of_month: s.week_of_month, month: s.month, time: s.time };
}
