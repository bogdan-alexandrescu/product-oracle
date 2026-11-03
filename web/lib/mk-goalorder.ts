// MOCK-HOOK: the whole file. mk-goalorder mock-ups (GO1 how the owner reorders goals, GO2 how a
// reader sees the order is deliberate). Switches: ?go1=a|b|c|d, ?go2=a|b|c|d, &goals=9 (hard case),
// &open=1, &phase=mid|done. The order is kept in localStorage so every page reads the same one.

export type MkGoal = { key: string; title: string; archived?: boolean };

// MOCK-HOOK: invented goals; the first five are the at-rest set, the rest make the hard case.
export const MK_GOALS: MkGoal[] = [
  { key: "faster-activation", title: "Faster activation" },
  { key: "grow-retention", title: "Grow retention" },
  { key: "paid-conversion", title: "Grow paid conversion" },
  { key: "quiet-alerts", title: "Keep alerts quiet" },
  { key: "support-load", title: "Cut support load" },
];
export const MK_HARD: MkGoal[] = [
  { key: "guided-week", title: "Make the first week feel guided for every new team, from sign-up to their first shared report" },
  { key: "mid-size", title: "Win more mid-size teams" },
  { key: "page-speed", title: "Faster page loads" },
  { key: "partner-store", title: "Open a partner app store", archived: true },
];

const KEY = "mk-goalorder"; // MOCK-HOOK
type Cfg = { go1?: string; go2?: string; goals?: string; order?: string[] };

const read = (): Cfg => {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Cfg;
  } catch {
    return {};
  }
};
const write = (c: Cfg) => localStorage.setItem(KEY, JSON.stringify(c));

/** A URL switch (?go1=b), else the one kept from the last page that had it. */
export function mk(name: "go1" | "go2" | "goals" | "open" | "phase"): string | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search).get(name);
  if (q != null) return q;
  if (name === "open" || name === "phase") return null;
  return read()[name] ?? null;
}

/** Keeps the URL's switches so the app's own links (Home to Roadmap) show the same proposal. */
export function mkRemember(): void {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search);
  if (!q.has("go1") && !q.has("go2")) return;
  const c = read();
  write({ ...c, go1: q.get("go1") ?? undefined, go2: q.get("go2") ?? undefined, goals: q.get("goals") ?? undefined });
}

export const mkOn = (): boolean => {
  mkRemember();
  return !!(mk("go1") || mk("go2"));
};

export const mkGoals = (): MkGoal[] => (mk("goals") === "9" ? [...MK_GOALS, ...MK_HARD] : MK_GOALS);

/** The owner's order, by goal title (the mock's goals on Home and the roadmap's lanes share titles). */
export function mkOrder(): string[] {
  const all = mkGoals().filter((g) => !g.archived).map((g) => g.title);
  const kept = read().order ?? [];
  return [...kept.filter((t) => all.includes(t)), ...all.filter((t) => !kept.includes(t))];
}

export function mkSetOrder(order: string[]): void {
  write({ ...read(), order });
  window.dispatchEvent(new Event("mk-goalorder"));
}

/** A goal's place in the order (0 first); one not in it goes last. */
export function mkRank(title: string): number {
  const i = mkOrder().indexOf(title);
  return i < 0 ? 999 : i;
}

/** Moves one goal to a new place in a list of titles. */
export function mkMove(order: string[], title: string, to: number): string[] {
  const rest = order.filter((t) => t !== title);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, title);
  return rest;
}
