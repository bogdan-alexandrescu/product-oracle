import type { Schemas } from "../client";
import { companyDayIso } from "./connections";

type RunOut = Schemas["RunOut"];

// As the API's _STOP_WORDS (oracle.simple.meetings): a run's stops as people name them in Simple.
const STOP_WORDS: Record<string, string> = {
  baseline_confirm: "Baseline",
  feature_set: "Feature set",
  eng_review: "Engineering check",
  priority_order: "Order",
  prd_review: "PRD review",
  eng_dates: "Dates",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
};
const STEP_WORDS: Record<string, string> = { approved: "Approved", changes_requested: "Sent back", skipped: "Skipped" };

const words = (kind: string) => STOP_WORDS[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * build-rundecide RD1 a, as the API's _run_groups: each run on a PRD the page lists with a decided
 * stop, newest first (20 at most); its stops in order, one row per stop, a stop sent back and then
 * approved one row with its steps. Skipped stops are not people's decisions and are left out.
 */
export function runGroupsOut(runs: RunOut[], docs: { id: string; slug: string; title: string }[], members: { id: string; name: string }[], prd?: string | null): Schemas["SimpleRunGroup"][] {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const shown = docs.filter((d) => !prd || d.slug === prd || d.id === prd);
  return [...runs]
    .filter((r) => shown.some((d) => d.id === r.document_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)
    .flatMap((r) => {
      const doc = shown.find((d) => d.id === r.document_id)!;
      const decided = r.checkpoints
        .filter((c) => c.status === "approved" || c.status === "changes_requested")
        .sort((a, b) => (a.segment_seq ?? 0) - (b.segment_seq ?? 0) || (a.decided_at ?? "~").localeCompare(b.decided_at ?? "~"));
      const byStop = new Map<string, typeof decided>();
      for (const c of decided) byStop.set(`${c.segment_seq ?? 0}|${c.kind}`, [...(byStop.get(`${c.segment_seq ?? 0}|${c.kind}`) ?? []), c]);
      const who = (c: (typeof decided)[number]) => {
        const by = (c.payload.decided as { by?: string | null } | undefined)?.by ?? c.decided_by;
        return (by && names.get(by)) || null;
      };
      const stops = [...byStop.values()].map((steps) => {
        const last = steps[steps.length - 1]!;
        const sentBack = steps.slice(0, -1).some((c) => c.status === "changes_requested");
        const role = (last.payload.decided as { role?: string | null } | undefined)?.role ?? null;
        return {
          checkpoint_id: last.id,
          kind: last.kind,
          stop: words(last.kind),
          outcome: last.status === "approved" && sentBack ? "Approved after a change" : STEP_WORDS[last.status] ?? last.status,
          who: who(last),
          role: role ? role.replace(/_/g, " ") : null,
          day: last.decided_at ? companyDayIso(last.decided_at) : null,
          note: last.note ?? null,
          trail: steps.length > 1 ? steps.map((c) => ({ what: STEP_WORDS[c.status] ?? c.status, who: who(c), day: c.decided_at ? companyDayIso(c.decided_at) : null, note: c.note ?? null })) : [],
        };
      });
      if (!stops.length) return [];
      return [{ run_id: r.id, name: `${doc.title.trim().replace(/\s+PRD$/i, "")} plan`, prd: { id: doc.slug, title: doc.title }, stops }];
    });
}
