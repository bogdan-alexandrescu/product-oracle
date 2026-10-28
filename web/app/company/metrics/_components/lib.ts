import type { ChipKind } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { addDays, dayIn } from "@/lib/dates";
import { formatDay } from "@/lib/format";

export type Metric = Schemas["MetricOut"];
export type MetricDetail = Schemas["MetricDetail"];
export type Variance = Schemas["VarianceOut"];

export const KIND_LABEL: Record<Metric["kind"], string> = { output: "Output", input: "Input" };
export const SOURCE_LABEL: Record<Metric["source"], string> = { posthog: "PostHog", manual: "By hand", api: "By API" };
export const DIRECTION_LABEL: Record<Metric["direction"], string> = { up: "Up is good", down: "Down is good" };
export const STATUS_LABEL: Record<Metric["status"], string> = { active: "Active", paused: "Paused", error: "Not read", archived: "Archived" };
export const STATUS_KIND: Record<Metric["status"], ChipKind> = { active: "pass", paused: "na", error: "crit", archived: "na" };
export const VARIANCE_LABEL = { better: "Better", worse: "Worse" } as const;
export const VARIANCE_KIND: Record<"better" | "worse", ChipKind> = { better: "pass", worse: "crit" };
export const VARIANCE_STATE: Record<Variance["status"], string> = { open: "Open", explained: "Explained", unknown: "Don't know yet", noise: "Noise" };

/** The goal units (B5): a percentage, a currency, a duration, or a counted noun typed in. */
export const UNITS = ["%", "USD", "EUR", "GBP", "ms", "s", "min", "h", "days"];

/** 412 → "412 teams"; 9.5 → "9.5%". */
export function valueText(v: number | null | undefined, unit: string): string {
  if (v == null) return "—";
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

/** +37 (+9.9%). */
export function changeText(value: number, pct: number | null | undefined): string {
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const v = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return pct == null ? sign(v) : `${sign(v)} (${sign(pct)}%)`;
}

/** "Oct 12": a week's Monday (a calendar day, the same in every zone). */
export const weekText = (day: string) => formatDay(day);

/** The Monday of the last complete week in the Company time zone, and the 12 before it. */
export function recentWeeks(zone: string, n = 13): string[] {
  const today = dayIn(Date.now(), zone);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const last = addDays(today, -weekday - 7);
  return Array.from({ length: n }, (_, i) => addDays(last, -7 * i));
}

/** The median of the absolute week-on-week changes in the last 12 (the variance rule's typical change). */
export function typicalChange(values: number[]): number | null {
  const changes = values
    .slice(-13)
    .slice(1)
    .map((v, i) => Math.abs(v - values.slice(-13)[i]));
  if (changes.length < 6) return null;
  const s = [...changes].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
