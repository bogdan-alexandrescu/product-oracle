/**
 * What is known about an account's windows, ported from SwarmCloud's swarm-ui
 * (`src/types.ts`: readingOf, isProjected, bindingWindow, humaniseUntil, clearsIn,
 * timeAgo; `src/Accounts.tsx`: clearsOf, anyProjected, agoPastDay).
 *
 * The rule the screen turns on: a missing reading is not zero, a stale reading is not a
 * current one, and a window that has reset describes a window that no longer exists.
 * An unmeasured figure prints an em dash; a projected one carries `~`.
 */
import type { Schemas } from "@/lib/api/client";

export type Account = Schemas["AccountOut"];
export type AccountWindow = Schemas["WindowOut"];

export const FIVE_HOUR = "five_hour";
export const SEVEN_DAY = "seven_day";

export type AccountReading =
  /** No reading has EVER arrived for this account. Not zero: unmeasured. */
  | { kind: "never" }
  /** Readings exist, but not for this window. */
  | { kind: "absent" }
  /** The window passed its reset, so the figure describes a window that refilled. */
  | { kind: "reset"; pct: number; resetsAt: string }
  /** A real figure, too old to trust. Shown, marked, never presented as current. */
  | { kind: "stale"; pct: number; resetsAt: string; observedAt: string }
  /** Measured, recent, and safe to read as a fact. */
  | { kind: "live"; pct: number; resetsAt: string; observedAt: string };

export function readingOf(a: Account, key: string): AccountReading {
  if (a.observed_at === null) return { kind: "never" };
  const w = a.windows[key];
  if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return { kind: "absent" };
  const pct = Math.max(0, Math.min(100, w.utilization * 100));
  // `reset` outranks `stale`: a fresh reading of a window that has since refilled is
  // still describing the window before it.
  if (w.reset) return { kind: "reset", pct, resetsAt: w.resets_at };
  if (a.stale) return { kind: "stale", pct, resetsAt: w.resets_at, observedAt: a.observed_at };
  return { kind: "live", pct, resetsAt: w.resets_at, observedAt: a.observed_at };
}

/** True for the two cases `cs status` prefixes with `~`. */
export function isProjected(r: AccountReading): boolean {
  return r.kind === "stale" || r.kind === "reset";
}

/** The window that will refuse first: least remaining, a reset window counted as full. */
export function bindingWindow(a: Account): { key: string; window: AccountWindow } | null {
  let best: { key: string; window: AccountWindow } | null = null;
  let leastRemaining = Infinity;
  for (const [key, w] of Object.entries(a.windows)) {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const remaining = w.reset ? 1 : Math.max(0, 1 - w.utilization);
    if (remaining < leastRemaining) {
      leastRemaining = remaining;
      best = { key, window: w };
    }
  }
  return best;
}

/** A duration the way somebody reads a clock: `3d 10h`, `1h 05m`, `40m`. */
export function humaniseUntil(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m >= 1) return `${m}m`;
  return `${s}s`;
}

export function clearsIn(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return humaniseUntil(t - now);
}

/** "3 hours", "1 day": a count with its unit in words. */
const units = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * Time SINCE an instant, in the screen's one relative style (qa-settings-19): `just now`,
 * `4 min ago`, `3 hours ago`, `9 days ago`. Never point it at a future instant: that is `clearsIn`.
 */
export function timeAgo(when: string | number, now: number = Date.now()): string {
  const t = typeof when === "number" ? when : new Date(when).getTime();
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 48 * 3600) return `${units(Math.round(s / 3600), "hour")} ago`;
  return `${units(Math.round(s / 86400), "day")} ago`;
}

/** An age past a day in days AND hours: `1 day 20 hours ago`, not `44 hours ago`. */
export function agoPastDay(when: string, now: number = Date.now()): string {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return timeAgo(when, now);
  const h = Math.floor((now - t) / 3_600_000);
  if (h < 24) return timeAgo(t, now);
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r === 0 ? `${units(d, "day")} ago` : `${units(d, "day")} ${units(r, "hour")} ago`;
}

/** `five_hour` -> `5-hour`, `seven_day` -> `7-day`; any other window by its name. */
export function windowWord(key: string): string {
  if (key === FIVE_HOUR) return "5-hour";
  if (key === SEVEN_DAY) return "7-day";
  return key.replace(/_/g, "-");
}

export interface Clears {
  text: string;
  /** Marked `~`: projected, not measured. */
  tilde: boolean;
  unmeasured: boolean;
  title: string;
  /** Which window, in the figures' own words (`5-hour`), or null with no binding window. */
  win: string | null;
}

/** Time until the BINDING window resets: CLEARS. One rule for the row and the tile. */
export function clearsOf(account: Account, now: number): Clears {
  const binding = bindingWindow(account);
  if (binding === null) {
    return {
      text: "—",
      tilde: false,
      unmeasured: true,
      title: "No window reading, so there is no reset instant to count down to.",
      win: null,
    };
  }
  const reading = readingOf(account, binding.key);
  const win = windowWord(binding.key);
  if (binding.window.reset) {
    return {
      text: "cleared",
      tilde: false,
      unmeasured: false,
      title: `The ${win} window, the binding one, has passed its reset; no reading taken since has arrived.`,
      win,
    };
  }
  const resetsAt = new Date(binding.window.resets_at).getTime();
  if (Number.isFinite(resetsAt) && resetsAt <= now) {
    return {
      text: "now",
      tilde: true,
      unmeasured: false,
      title: `The ${win} window's reset instant is already in the past; reload and the server answers.`,
      win,
    };
  }
  const uncertain = isProjected(reading);
  return {
    text: clearsIn(binding.window.resets_at, now),
    tilde: uncertain,
    unmeasured: false,
    title: uncertain
      ? `Counts down to the ${win} window's reset. Marked ~ because which window binds was decided from a figure that is no longer current.`
      : `The ${win} window is the binding one, the one that will refuse first, and this is when it resets.`,
    win,
  };
}

/** Whether any `~` is on screen, so the legend is drawn only where a tilde is. */
export function anyProjected(accounts: Account[], now: number): boolean {
  return accounts.some((a) => {
    if (readingOf(a, FIVE_HOUR).kind === "stale" || readingOf(a, SEVEN_DAY).kind === "stale") return true;
    const binding = bindingWindow(a);
    if (binding === null || binding.window.reset) return false;
    const at = new Date(binding.window.resets_at).getTime();
    if (Number.isFinite(at) && at <= now) return true;
    return isProjected(readingOf(a, binding.key));
  });
}

/** The one state only a person can clear. The sweep stops trying on it. */
export function needsAHuman(a: Account): boolean {
  return a.state === "REAUTH_REQUIRED";
}

/**
 * How badly an account needs a person, lower first; null when it does not:
 * 0 sign-in expired, 1 its credential could not be read, 2 its binding window is spent.
 */
export function attentionRank(a: Account): number | null {
  if (needsAHuman(a)) return 0;
  if (a.unreadable_now) return 1;
  const binding = bindingWindow(a);
  if (binding !== null) {
    const r = readingOf(a, binding.key);
    if ((r.kind === "live" || r.kind === "stale") && r.pct >= 100) return 2;
  }
  return null;
}

function byName(a: Account, b: Account): number {
  return a.label.localeCompare(b.label) || a.account_id.localeCompare(b.account_id);
}

/** The account the page opens on: the most urgent, else the most used, else alphabetical. */
export function defaultAccount(accounts: readonly Account[]): Account | null {
  if (accounts.length === 0) return null;
  const ranked = accounts
    .map((a) => ({ a, rank: attentionRank(a) }))
    .filter((x): x is { a: Account; rank: number } => x.rank !== null)
    .sort((x, y) => x.rank - y.rank || byName(x.a, y.a));
  if (ranked[0] !== undefined) return ranked[0].a;
  const used = accounts.filter((a) => a.assigned > 0).sort((x, y) => y.assigned - x.assigned || byName(x, y));
  return used[0] ?? [...accounts].sort(byName)[0] ?? null;
}

/** `Usage read 2–50 min ago`: the youngest to the oldest reading, rows with none left out. */
export function readingAges(accounts: Account[], now: number): string | null {
  const ages = accounts
    .map((a) => (a.observed_at === null ? Number.NaN : now - new Date(a.observed_at).getTime()))
    .filter((ms) => Number.isFinite(ms));
  if (ages.length === 0) return null;
  const youngest = timeAgo(now - Math.min(...ages), now);
  const oldest = timeAgo(now - Math.max(...ages), now);
  if (youngest === oldest) return `Usage read ${oldest}`;
  // One unit said once: "2–50 min ago"; mixed units each keep theirs.
  const m = /^(\d+) min ago$/;
  const [y, o] = [m.exec(youngest), m.exec(oldest)];
  return `Usage read ${y && o ? `${y[1]}–${o[1]} min ago` : `${youngest.replace(/ ago$/, "")} – ${oldest}`}`;
}
