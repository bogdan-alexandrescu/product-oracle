import type { Schemas } from "../client";
import { mockNowMs } from "./clock";

type Item = Schemas["SimpleWaitingItem"];

/** What a run stop asks, in plain words (oracle.simple.waiting_list _STOP_ACTION). */
const STOP_ACTION: Record<string, string> = {
  feature_set: "Check the feature set",
  eng_review: "Check the engineering review",
  priority_order: "Set the order",
  prd_review: "Review the PRD",
  eng_dates: "Review the dates",
  roadmap_items: "Check the roadmap items",
  baseline_confirm: "Confirm the baseline",
};

/** "Nov 4", with the year when it is not this year's ("Jan 8, 2027"). */
function day(d: string): string {
  const at = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  const thisYear = at.getUTCFullYear() === new Date(mockNowMs()).getUTCFullYear();
  return at.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) });
}

/**
 * home-waiting-one-list: the mock of oracle.simple.waiting_list. GET
 * /v1/simple/decisions/waiting's `items`, everything that waits on the signed-in person, read
 * from the mock's own answers to the routes each kind lives on (so it can never disagree with
 * them): the run stops they may decide, the PRD questions they own, broken links and dates on
 * items they decide, drafts waiting for their approval, proposals on their items and the goal
 * suggestions they decide.
 */
export async function waitingItems(get: (path: string) => Promise<unknown>, meId: string, questions: Schemas["SimpleQuestion"][]): Promise<Item[]> {
  const read = async <T,>(path: string): Promise<T | undefined> => (await get(path).catch(() => undefined)) as T | undefined;
  const [inbox, roadmap, drafts, changes, goals] = await Promise.all([
    read<Schemas["InboxOut"]>("/v1/inbox"),
    read<Schemas["SimpleRoadmapOut"]>("/v1/simple/roadmap"),
    read<Schemas["SimpleDraftOut"][]>("/v1/simple/drafts"),
    read<Schemas["SimpleChangeOut"][]>("/v1/simple/changes?status=proposed"),
    read<Schemas["SimpleGoalSuggestionsOut"]>("/v1/simple/goal-suggestions?status=open"),
  ]);
  const out: Item[] = [];
  for (const c of [...(inbox?.checkpoints ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (!c.can_decide || c.status !== "pending") continue;
    const action = STOP_ACTION[c.kind] ?? "Open the stop";
    out.push({ kind: "run_stop", key: `run_stop:${c.id}`, ref_id: c.id, title: action, detail: c.document_title || (c.document_slug ? `${c.document_slug.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase())} PRD` : c.flow_title || "A run"), action, href: `/runs/${c.run_id}`, at: c.created_at, op: null });
  }
  for (const q of questions) {
    out.push({ kind: "question", key: `question:${q.id}`, ref_id: q.id, title: `${q.code} ${q.title}`.trim(), detail: q.prd.title, action: "Decide", href: `/simple/decisions?prd=${q.prd.slug}`, at: null, op: null });
  }
  const titles = new Map((roadmap?.items ?? []).map((i) => [i.id, i.title]));
  for (const i of roadmap?.items ?? []) {
    if (!i.can_decide) continue;
    for (const f of i.flags) {
      if (f.state !== "red" || !f.fixes.length) continue;
      const dep = f.subject ? titles.get(f.subject) : undefined;
      out.push({
        kind: "broken_link",
        key: `broken_link:${i.id}:${f.kind}:${f.subject ?? ""}`,
        ref_id: i.id,
        title: i.title,
        detail: dep && !f.reason.includes(dep) ? `${f.reason} (${dep})` : f.reason,
        action: "Fix the link",
        href: `/simple/roadmap?item=${i.id}`,
        at: null,
        op: null,
      });
    }
    const s = i.suggestion;
    if (s && s.status === "open" && s.can_decide) {
      out.push({ kind: "date", key: `date:${s.id}`, ref_id: s.id, title: i.title, detail: `Oracle suggests ${day(s.start_date)} – ${day(s.end_date)}`, action: "Confirm the dates", href: `/simple/roadmap?item=${i.id}`, at: s.created_at, op: null });
    }
  }
  for (const d of drafts ?? []) {
    if (!d.waiting_on.includes(meId)) continue;
    out.push({ kind: "draft", key: `draft:${d.id}`, ref_id: d.id, title: d.document.title, detail: "A roadmap draft waits for your approval", action: "Approve", href: `/simple/roadmap?roadmap=${d.document.id}`, at: null, op: null });
  }
  for (const c of changes ?? []) {
    if (!c.can_decide || c.status !== "proposed") continue;
    const item = (c.target as { item_id?: string }).item_id;
    const date = c.op === "accept_date_suggestion";
    out.push({
      kind: date ? "date" : "proposal",
      key: `proposal:${c.id}`,
      ref_id: c.id,
      title: c.words || (date ? "New dates proposed" : "A proposed change"),
      detail: `Proposed by ${c.by_name}`,
      action: "Accept",
      href: item ? `/simple/roadmap?item=${item}` : "/simple/roadmap",
      at: c.at,
      op: c.op,
    });
  }
  for (const s of goals?.suggestions ?? []) {
    if (s.status !== "open" || !s.can_accept) continue;
    out.push({ kind: "goal_suggestion", key: `goal_suggestion:${s.id}`, ref_id: s.id, title: s.title, detail: `Suggested for ${s.goal.title}`, action: "Confirm", href: "/simple/goals", at: s.created_at, op: null });
  }
  return out;
}
