/**
 * Mock of oracle.quality.learned: what kept learnings tell later module and question
 * recommendations. Each target's net signal (+weight, -weight, 0 for notes) moves a question's
 * rank score by 10% of itself a point and a module's 0-1 score by 0.1 a point, never more than
 * 20% (0.2) either way; retired learnings never count.
 */
import type { Schemas } from "@/lib/api/client";

export const LEARNING_STEP = 0.1;
export const LEARNING_CAP = 0.2;

export interface Nudge {
  target: string;
  net: number;
  /** The learnings pulling the way of the net signal: how many, and their words, newest first. */
  count: number;
  statements: string[];
}
export type Nudges = Record<string, Nudge>;

const SIGN = { recommend_more: 1, recommend_less: -1, note: 0 } as const;

export function nudges(learnings: Schemas["LearningOut"][] | undefined, appliesTo: Schemas["LearningOut"]["applies_to"]): Nudges {
  const groups = new Map<string, Schemas["LearningOut"][]>();
  const newest = [...(learnings ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const l of newest) {
    if (l.status !== "active" || l.applies_to !== appliesTo) continue;
    groups.set(l.target, [...(groups.get(l.target) ?? []), l]);
  }
  const out: Nudges = {};
  for (const [target, ls] of groups) {
    const net = ls.reduce((s, l) => s + SIGN[l.direction] * l.weight, 0);
    if (net === 0) continue;
    const way = ls.filter((l) => SIGN[l.direction] === Math.sign(net));
    out[target] = { target, net, count: way.length, statements: way.slice(0, 3).map((l) => l.statement) };
  }
  return out;
}

export const factor = (n: Nudge) => Math.max(-LEARNING_CAP, Math.min(LEARNING_CAP, n.net * LEARNING_STEP));

export const applyNudge = (score: number, n: Nudge | undefined) => (n ? Math.round(score * (1 + factor(n)) * 1000) / 1000 : score);

export function nudgeReason(n: Nudge): string {
  const how = n.net > 0 ? "Recommended" : "Recommended less";
  const which = n.count === 1 ? "a learning" : `${n.count} learnings`;
  let said = n.statements[0].trim();
  if (said && !/[.!?]$/.test(said)) said += ".";
  return `${how} because of ${which} from past outcomes: ${said}`;
}
