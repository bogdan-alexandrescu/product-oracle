/**
 * chat-citations: Oracle's Ask in the panel's General chat (a `screen` on "/"), as the API's
 * context reads it (oracle.discussions.context): the confirmed goals, then the baseline's
 * features with their status and the goals they serve, each a `[c:n]` citation. Asked for the
 * focus areas with their features, it answers from them, citing them, and with a meeting-notes
 * read (`[l:1]`). As a model may, it also writes tokens the API passes through untouched
 * ("[c:c4]", "[s:12]"): the panel never shows them.
 */
import type { BaselineState } from "./baseline";

export const GENERAL_FOCUS = /focus areas?|baseline features?/i;

type Reply = { pieces: string[]; citations: Record<string, unknown>[] };

export function generalReply(baseline: BaselineState, path: string, question: string, now: string): Reply | null {
  if (path !== "/" || !GENERAL_FOCUS.test(question)) return null;
  const goals = baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed").slice(0, 3);
  if (!goals.length) return null;
  const citations: Record<string, unknown>[] = [];
  const cite = (kind: string, title: string, id: string) => {
    citations.push({ n: citations.length + 1, kind, ref: id, title, url: `/baseline#${id}` });
    return `[c:${citations.length}]`;
  };
  const goalCite = new Map(goals.map((g) => [g.id, cite("entity", `Goal: ${g.title}`, g.id)]));
  const lines = goals.map((g) => {
    const features = baseline.edges
      .filter((x) => x.type === "supports" && x.dst_id === g.id && x.status !== "rejected")
      .map((x) => baseline.entities.find((e) => e.id === x.src_id && e.type === "feature" && e.status !== "rejected"))
      .filter((e) => !!e)
      .slice(0, 3);
    const named = features.map((f) => `${f.title} (${f.status}) ${cite("entity", `Feature: ${f.title}`, f.id)}`);
    return `- **${g.title}** ${goalCite.get(g.id)}: ${named.length ? named.join(", ") : "no features yet"}`;
  });
  const first = goals[0];
  citations.push({ kind: "live", ref: "l:1", source: "Meeting notes", call: "search", read_at: now, item_id: null });
  return {
    pieces: [
      "**Focus areas**\n\n",
      `${lines.join("\n")}\n\n`,
      `How much ${first.title} moves is still unknown ${goalCite.get(first.id)}[c:c4] [s:12]. `,
      "The last planning call named the same three [l:1].",
    ],
    citations,
  };
}
