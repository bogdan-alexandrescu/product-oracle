"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { copyOf, setupOpen } from "@/app/home/_setup";
import { Avatar, Block, GoalBandSkeleton, HomeCard, HomeRow, RowIcon, SkeletonRows, Top } from "@/app/simple/_home/cards";
import { Walk } from "@/app/simple/_home/walk";
import { SimpleWelcome } from "@/app/simple/_home/welcome";
import { Icon } from "@/components/ds/Icon";
import { Dialog } from "@/components/ds/Dialog"; // MOCK-HOOK
import { setToastPlace, toast } from "@/components/ds/Toast";
import { GoalPanel, SuggestionsButton, useGoalSuggestions, type GoalBrief } from "@/components/simple/GoalSuggestions";
import { usePhone } from "@/components/simple/FlowViews";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { QuestionRow, useQuestionActions, type Question } from "@/components/simple/questions/Questions";
import { SimplePage } from "@/components/simple/SimplePage";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import {
  beforeAfter,
  brokenLinks,
  changeWords,
  goalTiles,
  greeting,
  NEW_FLOW_OPS,
  OP_WORDS,
  planByMonth,
  planInputs,
  prdInPlay,
  waitSentence,
  type BrokenLink,
  type GoalTile,
} from "@/lib/simple-home";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, waitingChanged } from "@/lib/waiting";

type Change = Schemas["SimpleChangeOut"];
type Decision = Schemas["DecisionOut"];

/** Where a proposal is reviewed: the roadmap's "Needs a decision" list, at its Proposals part (qa-simple-home-14). */
const REVIEW = "/simple/roadmap?review=proposals";

/** A broken link's one-click fixes, and what each did, in a toast ("Risk accepted in your working draft"). */
type FixOp = "shift_dependents" | "move_dependency" | "accept_risk";
const FIX_OPS = new Set<string>(["shift_dependents", "move_dependency", "accept_risk"]);
const FIX_DONE: Record<FixOp, string> = {
  shift_dependents: "Dependents moved",
  move_dependency: "Dependency moved",
  accept_risk: "Risk accepted",
};
/** A fix's button words, the Roadmap's (qa-simple-home-12: OP_WORDS, one wording in both places). */
const FIX_WORDS: Record<FixOp, string> = {
  shift_dependents: OP_WORDS.shift_dependents,
  move_dependency: OP_WORDS.move_dependency,
  accept_risk: "Accept as risk",
};

/**
 * Where each Set up step opens from Simple (the same pages as Detailed Home's checklist,
 * app/home/_setup.tsx, whose words and figures the card reads: qa-onboarding-19), with
 * from=simple-setup so the step's "Back to Home" returns here (qa-onboarding-34). A step this
 * build has no page for keeps its row with no link.
 */
const SETUP_STEPS: Record<string, string> = {
  connect: "/settings/connections?from=simple-setup",
  sources: "/settings/sources?from=simple-setup",
  invite: "/settings/members?from=simple-setup",
  domains: "/settings/sources?from=simple-setup#company-domains",
  eng_lead: "/settings/members?from=simple-setup#engineering-lead",
  horizons: "/settings/company?from=simple-setup#horizons",
  timezone: "/settings/company?from=simple-setup#timezone",
  build_baseline: "/baseline?build=1",
};

/** An item code before a name ("F-06 Weekly alert digest"): Simple says the name alone (qa-simple-home-13). */
const withoutCodes = (text: string) => text.replace(/\b[A-Z]{1,3}-\d{1,4}\s+/g, "");

/** The sentence under a broken link's item, without the item's name the heading already says (qa-simple-home-11). */
function problemWords(reason: string, title: string): string {
  const own = [`'${title}' `, `'${title.length <= 40 ? title : `${title.slice(0, 39)}…`}' `].find((p) => reason.startsWith(p));
  const rest = own ? reason.slice(own.length) : reason;
  const plain = rest.replace(/(^|[\s(])'([^']+?)'(?=[\s,.)]|$)/g, "$1$2");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const joinAnd = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/**
 * What "Move the dependents" moves (qa-simple-home-1): the items the flag names (SimpleFlag.moves),
 * as the change engine moves them, the clicked item first.
 */
function shiftMoves(b: BrokenLink, items: Schemas["SimpleRoadmapItem"][]): Schemas["SimpleRoadmapItem"][] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return (b.flag.moves ?? []).map((id) => byId.get(id)).filter((i): i is Schemas["SimpleRoadmapItem"] => !!i);
}

const STATUS_TONE: Record<GoalTile["status"], string> = {
  "At risk": "simple-status-risk",
  "Not measured yet": "simple-status-quiet",
  "Not counted yet": "simple-status-quiet",
  Planned: "simple-status-ok",
};

/**
 * Simple's Home (#723 S1, the owner's pick "Brief as cards"): the greeting, the goal band, the
 * summary card and one card per section (decisions waiting for me, proposals on my items, the
 * next review meeting, the plan this quarter, since my last visit), each loading and failing on
 * its own. Every action goes through the API with the caller's permissions: decisions through
 * H1's decide, proposals and the broken-link fixes through the change engine (owners and the
 * decider apply with Undo, others propose, viewers read). Roles only through can() and the
 * rows' own can_* fields.
 */
export default function SimpleHome() {
  const { me, can, capsReady } = useMe();
  const zone = useCompanyZone();
  const [stamp, setStamp] = useState(0);
  // S9: "Walk me through it" turns Home into a guided pass; Done returns here.
  const [walking, setWalking] = useState(false);
  const k = (name: string) => `simple-home|${name}|${stamp}`;
  // qa-simple-home-30: Home's toasts sit bottom-left over the rail, clear of the rows' buttons.
  useEffect(() => setToastPlace("rail"), []);
  const reloadAll = () => {
    invalidateWaiting();
    setStamp((s) => s + 1);
    waitingChanged();
  };

  const inbox = useQuery(k("inbox"), loadInbox, { keepPrevious: true });
  const roadmap = useQuery(k("roadmap"), () => unwrap(api.GET("/v1/simple/roadmap")), { keepPrevious: true });
  const goals = useQuery(k("goals"), () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })), { keepPrevious: true });
  const changes = useQuery(k("changes"), () => unwrap(api.GET("/v1/simple/changes")), { keepPrevious: true });
  const drafts = useQuery(k("drafts"), () => unwrap(api.GET("/v1/simple/drafts")), { keepPrevious: true });
  // prd-questions: the one list of product decisions waiting for me (GET /v1/simple/decisions/waiting):
  // its count, its late count and the PRDs' questions; then the other judgement calls from the
  // Inbox, never Oracle's run approvals (class checkpoint) nor a PRD's question read twice.
  const waiting = useQuery(k("waiting"), () => unwrap(api.GET("/v1/simple/decisions/waiting")), { keepPrevious: true });
  const decisions = useQuery(
    k("decisions"),
    async (): Promise<Decision[]> => {
      const rows = (await loadInbox()).decisions.filter((d) => d.counts && d.reason === "needs_decision");
      const all = await Promise.all(rows.map((d) => unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: String(d.number) } } }))));
      return all.filter((d) => d.class !== "checkpoint" && d.origin !== "checkpoint" && (d.origin as string) !== "prd");
    },
    { keepPrevious: true },
  );
  const questionActions = useQuestionActions(reloadAll);
  // A4: a phone's Home shows the soonest two decisions, a desktop's three.
  const phone = usePhone();
  // The one list of scheduled reviews (Meetings > Upcoming): its first row is the next.
  const meeting = useQuery(k("meeting"), async () => {
    const list = await unwrap(api.GET("/v1/simple/meetings"));
    return { next: list.upcoming[0] ?? null };
  });
  const personIds = useMemo(() => {
    const ids = new Set<string>((drafts.data ?? []).flatMap((d) => d.waiting_on));
    for (const c of changes.data ?? []) if (c.status === "proposed") c.routed_to.forEach((id) => ids.add(id));
    return [...ids].sort();
  }, [drafts.data, changes.data]);
  // keepPrevious: names already read stay while a new id set loads (a toast never reads a gap).
  const people = useQuery(
    k(`people|${personIds.join(",")}`),
    () => (personIds.length ? unwrap(api.GET("/v1/people", { params: { query: { ids: personIds } } })) : Promise.resolve([] as Schemas["PersonOut"][])),
    { keepPrevious: true },
  );
  /** A person by their display name (GET /v1/people), never by an email's local part. */
  const nameOf = (id: string, fallback: string) => people.data?.find((p) => p.user_id === id)?.name ?? fallback;
  // qa-onboarding-4: the Set up checklist (GET /v1/setup, Detailed Home's): its steps are the
  // caller's (an owner's all, a commenter's own two, a viewer's none), until each is done.
  const setupQ = useQuery(k("setup"), () => (can("get_setup") ? unwrap(api.GET("/v1/setup")) : Promise.resolve(undefined)), { keepPrevious: true });
  const setup = can("get_setup") && setupOpen(setupQ.data) && !setupQ.data.hidden ? setupQ.data : null;
  async function hideSetup() {
    try {
      await unwrap(api.PATCH("/v1/me/preferences", { body: { setup_hidden: true } }));
      toast({ message: "Set up hidden. Detailed Home keeps it behind its Set up chip." });
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    void setupQ.reload();
  }
  const decidedLately = useQuery(k("decided"), () => unwrap(api.GET("/v1/decisions", { params: { query: { status: "decided" } } })));
  const onePagers = useQuery(k("one-pagers"), () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));

  // S7: Oracle's suggested features under each goal of the band (an accept reloads Home).
  const suggestions = useGoalSuggestions(reloadAll);
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
  const [qp4, setQp4] = useState<string | null>(null); // MOCK-HOOK
  useEffect(() => setQp4(new URLSearchParams(window.location.search).get("qp4")), []); // MOCK-HOOK
  const [mkSummary, setMkSummary] = useState<Change | null>(null); // MOCK-HOOK qp4=b: the proposal whose Accept shows its moves first
  const [mkAll, setMkAll] = useState<string | null>(null); // MOCK-HOOK qp4=a: the row whose every move shows
  const [mkOpenGoal, setMkOpenGoal] = useState<string | null>(null); // MOCK-HOOK qp4=c: the goal card opened in place
  const proposes = can("create_simple_change");
  const decidesAll = can("accept_simple_change");
  const reads = !proposes;
  const myId = me?.user_id ?? "";

  const toDecide = useMemo(() => (changes.data ?? []).filter((c) => c.status === "proposed" && c.can_decide), [changes.data]);
  const mine = useMemo(() => (changes.data ?? []).filter((c) => c.status === "proposed" && c.by === myId), [changes.data, myId]);
  const broken = useMemo(() => brokenLinks(roadmap.data), [roadmap.data]);
  const waitingItems = useMemo(() => {
    const ids = new Set<string>();
    for (const c of toDecide) if (typeof c.target.item_id === "string") ids.add(c.target.item_id);
    for (const b of broken) if (b.item.can_decide) ids.add(b.item.id);
    return ids;
  }, [toDecide, broken]);
  const tiles = useMemo(() => (goals.data ? goalTiles(goals.data, roadmap.data, waitingItems) : undefined), [goals.data, roadmap.data, waitingItems]);
  // A new company (no goals yet) leads with its setup; an established company's Simple Home keeps
  // its picked design (Detailed Home keeps the checklist behind its Set up chip).
  const setupFirst = !!setup && tiles !== undefined && tiles.length === 0;
  // The plan this quarter: the PRD in play (the top PRD by priority when several) by month.
  const priorities = useQuery(k("priorities"), () => unwrap(api.GET("/v1/simple/priorities")), { keepPrevious: true });
  // With several PRDs in play, chosen once the ranking answered (or failed), so the strip never
  // switches PRDs under the reader; with one, at once (undefined: waiting on the ranking).
  const ranked = priorities.data !== undefined || !!priorities.error;
  const planPrd = useMemo(
    () => prdInPlay(roadmap.data, ranked ? (priorities.data?.rows ?? []).map((r) => r.item_id) : null),
    [ranked, roadmap.data, priorities.data],
  );
  const plan = useMemo(
    () => (roadmap.data && planPrd ? planByMonth(roadmap.data.items.filter((i) => i.prd?.id === planPrd.id && i.status !== "cut").flatMap(planInputs), roadmap.data.today, roadmap.data.windows.now.end) : null),
    [roadmap.data, planPrd],
  );
  const draft = (drafts.data ?? []).find((d) => d.status === "working" && d.changes > 0 && (d.created_by === myId || d.participant_ids.includes(myId)));
  const proposalRows = toDecide.length > 0 || decidesAll ? toDecide : mine;
  const proposalTitle = toDecide.length > 0 || decidesAll ? "Proposals on your items" : "Your proposals waiting";
  // A decider's own proposals on items others decide wait too: their own card.
  const mineApart = proposalRows === toDecide ? mine : [];
  const itemTitle = (id: unknown) => roadmap.data?.items.find((i) => i.id === id)?.title ?? "An item";

  const now = new Date();
  /** A moment's day in the company zone, comparable ("2026-10-30"). */
  const zoneDay = (iso: string) => formatInZone(iso, zone, { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
  const hour = Number(formatInZone(now.toISOString(), zone, { hour: "numeric", hourCycle: "h23" }).replace(/\D.*$/, "")) || 9;
  // A person with no name is greeted plainly, never by their email's local part.
  const firstName = (me?.name ?? "").trim().split(/\s/)[0];
  const decisionCount = waiting.data?.count ?? 0;
  // Every broken link the tile counts: those I decide wait on me, the others I may propose fixes for.
  const brokenMine = broken.filter((b) => b.item.can_decide).length;
  const brokenOthers = broken.length - brokenMine;
  const waits = waitSentence([
    [decisionCount, "decision", "decisions"],
    [proposalRows === toDecide ? toDecide.length : 0, "proposal", "proposals"],
    [brokenMine, "broken link", "broken links"],
  ]);
  const brokenWords = brokenOthers === 1 ? "a broken link" : "broken links";
  const sentence = reads
    ? "Here is where the plan stands."
    : brokenOthers === 0
      ? waits
      : brokenMine + decisionCount + (proposalRows === toDecide ? toDecide.length : 0) === 0
        ? `You can propose fixes for ${brokenWords}.`
        : `${waits} You can also propose fixes for ${brokenWords}.`;
  // Nothing waits and no review is due (a new company): no walk to offer. Unknown until its reads answer.
  const counted = [waiting, changes, roadmap, meeting].every((q) => q.data !== undefined || !!q.error);
  const nothingToWalk = counted && decisionCount + toDecide.length + mine.length + broken.length === 0 && !meeting.data?.next;
  // qa-simple-home-16: nothing waits on me (no decision, no proposal): one line, not two empty cards and two 0 tiles.
  // An empty section alone is not shown either (its tile neither): the cards that wait on me lead.
  const decisionRows = waiting.data && decisions.data ? homeDecisionRows(waiting.data.questions, decisions.data) : undefined;
  const decisionsEmpty = decisionRows !== undefined && decisionRows.length === 0;
  const proposalsEmpty = !!changes.data && proposalRows.length === 0;
  const quiet = decisionsEmpty && proposalsEmpty && mineApart.length === 0;
  // qa-onboarding-21: a tile that cannot apply yet (no roadmap items, so no links to break) is not shown.
  const tilesShown = (
    [
      ["decisions", waiting.data ? decisionCount : null, "decisions waiting for you", "decisions"],
      ["proposals", changes.data ? proposalRows.length : null, proposalRows === toDecide ? "proposals on your items" : "of your proposals waiting", "proposals"],
      ["broken-links", roadmap.data ? broken.length : null, "broken links", "broken links"],
    ] as const
  ).filter(([id]) => (id === "broken-links" ? (roadmap.data?.items.length ?? 1) > 0 : id === "decisions" ? !decisionsEmpty : !proposalsEmpty));
  // The goal band's weights as their share of the score ("50% of the score").
  const weightSum = (tiles ?? []).reduce((n, g) => n + (g.weight != null && g.weight > 0 ? g.weight : 0), 0);
  /** A goal's features on the roadmap (filtered to it), or Priorities when none is planned yet. */
  const goalHref = (id: string) => {
    const key = roadmap.data?.items.find((i) => i.goal?.id === id)?.goal?.key;
    return key ? `/simple/roadmap?goal=${encodeURIComponent(key)}` : "/simple/priorities";
  };
  const share = (w: number | null) => (w != null && w > 0 && weightSum > 0 ? Math.round((w / weightSum) * 100) : null);
  // The broken-links list's heading names the roadmaps they are on.
  const brokenRoadmaps = [...new Set(broken.map((b) => b.item.roadmap.title))];
  const brokenByItem = useMemo(() => {
    const by = new Map<string, BrokenLink[]>();
    for (const b of broken) by.set(b.item.id, [...(by.get(b.item.id) ?? []), b]);
    return [...by.values()];
  }, [broken]);
  const brokenDeciders = [...new Set(broken.filter((b) => !b.item.can_decide).flatMap((b) => (b.item.deciders.length ? b.item.deciders : ["the decider"])))];

  /** MOCK-HOOK qp4: what a keyed change moves, item by item: its dates before and after. */
  const mkMoves = (c: Change) => // MOCK-HOOK
    Object.entries(c.after as Record<string, unknown>) // MOCK-HOOK
      .filter(([, v]) => !!v && typeof v === "object" && "start_date" in (v as object)) // MOCK-HOOK
      .map(([id, v]) => { // MOCK-HOOK
        const a = v as { start_date?: string; end_date?: string }; // MOCK-HOOK
        const b = ((c.before as Record<string, unknown>)[id] ?? {}) as { start_date?: string; end_date?: string }; // MOCK-HOOK
        const span = (x: { start_date?: string; end_date?: string }) => `${x.start_date ? calendarDay(x.start_date) : "undated"} – ${x.end_date ? calendarDay(x.end_date) : "undated"}`; // MOCK-HOOK
        return { id, title: itemTitle(id), before: span(b), after: span(a) }; // MOCK-HOOK
      }); // MOCK-HOOK
  const mkMoveList = (c: Change, cut?: number) => { // MOCK-HOOK
    const moves = mkMoves(c); // MOCK-HOOK
    const shown = cut && moves.length > cut + 1 ? moves.slice(0, cut) : moves; // MOCK-HOOK
    return ( // MOCK-HOOK
      <ul className="simple-small mt-1 flex flex-col gap-1" data-testid="mk-moves">{/* MOCK-HOOK */}
        {shown.map((m) => ( // MOCK-HOOK
          <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">{/* MOCK-HOOK */}
            <span className="font-medium text-text">{m.title}</span>{/* MOCK-HOOK */}
            <del className="rounded bg-crit-bg px-1.5 text-crit">{m.before}</del>{/* MOCK-HOOK */}
            <span aria-hidden>→</span>{/* MOCK-HOOK */}
            <ins className="rounded bg-pass-bg px-1.5 text-pass no-underline">{m.after}</ins>{/* MOCK-HOOK */}
          </li> // MOCK-HOOK
        ))}{/* MOCK-HOOK */}
        {shown.length < moves.length && ( // MOCK-HOOK
          <li><button type="button" className="font-semibold text-accent-ink underline" onClick={() => setMkAll(c.id)}>and {moves.length - shown.length} more</button></li> // MOCK-HOOK
        )}{/* MOCK-HOOK */}
      </ul> // MOCK-HOOK
    ); // MOCK-HOOK
  }; // MOCK-HOOK
  const proposalRow = (c: Change) => (
    <HomeRow
      key={c.id}
      testId="home-proposal"
      lead={<Avatar name={c.by_name} />}
      title={`${OP_WORDS[c.op] ?? c.op}: ${itemTitle(c.target.item_id)}${typeof c.after.title === "string" && NEW_FLOW_OPS.has(c.op) ? ` · ${c.after.title}` : ""}`}
      meta={qp4 === "a" && mkMoves(c).length > 0 ? ( // MOCK-HOOK
        <>{`${c.by === myId ? "You" : c.by_name} · ${formatInZone(c.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${c.reason ? ` · ${c.reason}` : ""}`}{mkMoveList(c, mkAll === c.id ? undefined : 2)}</>// MOCK-HOOK
      ) : `${c.by === myId ? "You" : c.by_name} · ${formatInZone(c.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${c.reason ? ` · ${c.reason}` : ""}`}
      change={NEW_FLOW_OPS.has(c.op) ? null : beforeAfter(c)}
      thumb={NEW_FLOW_OPS.has(c.op)}
      inlineActions
      actions={
        qp4 === "c" && c.can_decide ? ( // MOCK-HOOK
          <Link href={REVIEW} className="simple-button simple-button-primary" data-testid="mk-review">Review on the roadmap</Link> // MOCK-HOOK
        ) : c.can_decide ? ( // MOCK-HOOK
          <>
            <button
              type="button"
              className="simple-button simple-button-primary"
              onClick={() => (qp4 === "b" && mkMoves(c).length > 0 ? setMkSummary(c) : void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: c.id } } })), "Accepted"))} // MOCK-HOOK
            >
              Accept
            </button>
            <button
              type="button"
              className="simple-button"
              onClick={() => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/decline", { params: { path: { change_id: c.id } } })), "Declined")}
            >
              Decline
            </button>
          </>
        ) : (
          <span className="simple-small">Waiting for {c.routed_to.length ? c.routed_to.map((id) => nameOf(id, "the decider")).join(", ") : "the decider"}</span>
        )
      }
    />
  );

  async function act(run: () => Promise<unknown>, done: string) {
    try {
      await run();
      toast({ message: done });
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    reloadAll();
  }

  async function changeResult(r: { change: Change }, applied: string) {
    const c = r.change;
    if (c.status === "proposed") {
      // Who it waits on may be someone this page has not named yet: read them first.
      const unknown = c.routed_to.filter((id) => !people.data?.some((p) => p.user_id === id));
      const more = unknown.length ? await unwrap(api.GET("/v1/people", { params: { query: { ids: unknown } } })).catch(() => []) : [];
      const who = c.routed_to.map((id) => more.find((p) => p.user_id === id)?.name ?? nameOf(id, "the decider"));
      return `Proposed: ${who.length ? who.join(", ") : "the decider"} ${who.length > 1 ? "decide" : "decides"}`;
    }
    return applied;
  }

  async function fix(b: BrokenLink, op: FixOp, note = "") {
    const dep = b.dependency;
    const body: Schemas["SimpleChangeIn"] =
      op === "accept_risk"
        ? { op, target: { item_id: b.item.id, flag: b.flag.kind, subject: b.flag.subject }, before: { risk: null }, after: { risk: { note: note.trim() } } }
        : {
            op,
            target: { item_id: b.item.id, subject: b.flag.subject },
            before: { [b.item.id]: stored(b.item), ...(dep ? { [dep.id]: stored(dep) } : {}) },
          };
    try {
      const r = await unwrap(api.POST("/v1/simple/changes", { body }));
      const message = await changeResult(r, `${FIX_DONE[op]} in your working draft${op === "accept_risk" ? "" : await movedWords(r.change)}`);
      const id = r.change.status === "applied" && r.change.can_undo ? r.change.id : null;
      toast(
        id
          ? { message, action: { label: "Undo", onClick: () => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: id } } })), "Undone") } }
          : { message },
      );
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    reloadAll();
  }

  /**
   * qa-simple-home-2: what a move did, beyond the row clicked: each item moved and its new
   * dates, and any of them now ending after its milestone (the roadmap read again).
   */
  async function movedWords(c: Change): Promise<string> {
    if (c.status !== "applied") return "";
    const after = c.after as Record<string, { start_date?: string | null; end_date?: string | null } | undefined>;
    const ids = Object.keys(after).filter((id) => after[id]?.end_date);
    if (!ids.length) return "";
    const fresh = await unwrap(api.GET("/v1/simple/roadmap")).catch(() => roadmap.data);
    const day = (d: string) => calendarDay(d, { month: "short", day: "numeric" });
    const moved = ids.map((id) => {
      const a = after[id]!;
      return `${fresh?.items.find((i) => i.id === id)?.title ?? itemTitle(id)} now ${a.start_date ? `${day(a.start_date)} – ` : "ends "}${day(a.end_date!)}`;
    });
    const late = ids.flatMap((id) => {
      const i = fresh?.items.find((x) => x.id === id);
      return (i?.flags ?? []).filter((f) => f.kind === "outside_milestone" && f.state === "red").map((f) => `${i!.title} ${problemWords(f.reason, i!.title).replace(/^./, (x) => x.toLowerCase())}`);
    });
    return `: ${joinAnd(moved)}.${late.length ? ` ${late.join(". ")}.` : ""}`;
  }

  function decide(d: Decision, key: string) {
    const option = d.options.find((o) => o.key === key)!;
    if (key === "declined" && d.can_withdraw) {
      // A proposal's Decline (a commenter's decision from the Ask panel) ends it: withdrawn, never decided.
      void act(
        () => unwrap(api.POST("/v1/decisions/{decision}/withdraw", { params: { path: { decision: String(d.number) } }, body: { reason: "Declined on Simple's Home" } })),
        `Declined: ${d.title}`,
      );
      return;
    }
    void act(
      () =>
        unwrap(
          api.POST("/v1/decisions/{decision}/decide", {
            params: { path: { decision: String(d.number) } },
            body: { option_key: key, rationale: `Decided on Simple's Home: ${option.label}`, expected_outcome: option.summary || option.label, lock_version: d.lock_version },
          }),
        ),
      `Decided: ${option.label}`,
    );
  }

  return (
    <SimplePage title="Home">
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} onClose={() => setGoalPanel(null)} />}
      {mkSummary && ( // MOCK-HOOK
        <Dialog title={`Accept: ${OP_WORDS[mkSummary.op] ?? mkSummary.op}`} testId="mk-summary" onClose={() => setMkSummary(null)} actions={<button type="button" className="simple-button simple-button-primary" onClick={() => { const c = mkSummary; setMkSummary(null); void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: c.id } } })), "Accepted"); }}>{`Accept and move ${mkMoves(mkSummary).length} ${mkMoves(mkSummary).length === 1 ? "item" : "items"}`}</button>}>{/* MOCK-HOOK */}
          <p className="simple-small">{mkSummary.by_name} proposed this{mkSummary.reason ? `: “${mkSummary.reason}”` : "."} These dates change:</p>{/* MOCK-HOOK */}
          {mkMoveList(mkSummary)}{/* MOCK-HOOK */}
        </Dialog> // MOCK-HOOK
      )}{/* MOCK-HOOK */}
      <header data-testid="home-greeting" className="-mt-4 flex flex-col gap-1">
        <p className="simple-small tnum">{formatInZone(now.toISOString(), zone, { weekday: "long", month: "long", day: "numeric" })}</p>
        <p className="simple-lead max-[600px]:min-h-[2lh]">
          {greeting(hour)}
          {firstName ? `, ${firstName}` : ""}. <span data-testid="home-sentence">{sentence}</span>
        </p>
        {!walking && capsReady && !reads && counted && !nothingToWalk && (
          <div>
            <button type="button" className="simple-button simple-button-primary" onClick={() => setWalking(true)}>
              Walk me through it
            </button>
          </div>
        )}
        {/* While the role or what waits is unknown the walk's slot keeps its height; a reader known has no walk and no gap. */}
        {!walking && (!capsReady || (!reads && !counted)) && (
          <div aria-hidden data-testid="home-walk-slot" className="invisible">
            <span className="simple-button">Walk me through it</span>
          </div>
        )}
      </header>

      {walking && (
        <Walk
          onDone={() => {
            setWalking(false);
            reloadAll();
          }}
        />
      )}

      {!walking && (
      <>
      {/* qa-onboarding-6: an invited member's role welcome, in Simple too (dismissed in one mode, gone in both). */}
      <SimpleWelcome show={setupQ.data?.welcome === true} onDismissed={() => void setupQ.reload()} />
      {setupFirst && setup && (can("put_setting") || !setupQ.data?.welcome) && <SetupCard setup={setup} owner={can("put_setting")} onHide={() => void hideSetup()} />}

      <section aria-label="Goals" data-testid="home-goals">
        <Block q={{ ...goals, data: tiles }} testId="home-goals" skeleton={<GoalBandSkeleton />}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="simple-small" data-testid="home-goals-empty">
                No confirmed company goals yet.
              </p>
            ) : (
              <ul className="simple-goal-band">
                {rows.map((g) => (
                  <li key={g.id} data-testid="home-goal" className="simple-goal">
                    {/* With Ask open the cards narrow: the guardrail tag and the share each keep one line, the share moving under. */}
                    {(g.guardrail || share(g.weight) != null) && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {g.guardrail && <span className="simple-tag">guardrail</span>}
                        {share(g.weight) != null && (
                          <span data-testid="home-goal-weight" className="simple-small tnum">
                            Counts for {share(g.weight)}% of each feature&apos;s score
                          </span>
                        )}
                      </div>
                    )}
                    {/* qa-simple-home-26: the goal opens its features on the roadmap; its code (qa-simple-home-13) only in the tooltip. */}
                    {qp4 && (qp4 === "c" || !roadmap.data?.items.some((i) => i.goal?.id === g.id) && qp4 === "a") ? ( // MOCK-HOOK
                      <span className="font-semibold text-text" data-testid="home-goal-link">{g.name}</span> // MOCK-HOOK
                    ) : ( // MOCK-HOOK
                    <Link
                      href={qp4 === "b" ? `/simple/priorities?goal=${encodeURIComponent(g.name)}` : goalHref(g.id)} // MOCK-HOOK
                      data-testid="home-goal-link"
                      title={g.code ? `${g.code} · ${g.name}` : g.name}
                      className="font-semibold text-text hover:underline"
                    >
                      {g.name}
                    </Link>
                    )}{/* MOCK-HOOK */}
                    {qp4 === "a" && ( // MOCK-HOOK
                      <span className="simple-small" data-testid="mk-goal-planned">{(() => { const n = roadmap.data?.items.filter((i) => i.goal?.id === g.id).length ?? 0; return n ? `${n} planned · opens on the roadmap` : "Nothing planned yet"; })()}</span> // MOCK-HOOK
                    )}{/* MOCK-HOOK */}
                    {qp4 === "c" && ( // MOCK-HOOK
                      <button type="button" aria-expanded={mkOpenGoal === g.id} onClick={() => setMkOpenGoal(mkOpenGoal === g.id ? null : g.id)} className="simple-small self-start font-semibold text-accent-ink underline" data-testid="mk-goal-open">{/* MOCK-HOOK */}
                        {mkOpenGoal === g.id ? "Hide what's planned" : `What's planned (${roadmap.data?.items.filter((i) => i.goal?.id === g.id).length ?? 0})`}{/* MOCK-HOOK */}
                      </button> // MOCK-HOOK
                    )}{/* MOCK-HOOK */}
                    {qp4 === "c" && mkOpenGoal === g.id && ( // MOCK-HOOK
                      <ul className="simple-small flex flex-col gap-0.5" data-testid="mk-goal-items">{/* MOCK-HOOK */}
                        {(roadmap.data?.items.filter((i) => i.goal?.id === g.id) ?? []).map((i) => <li key={i.id}><Link href={`/simple/roadmap?goal=${encodeURIComponent(i.goal?.key ?? "")}`} className="underline">{i.title}</Link> · {calendarDay(i.start.date)} – {calendarDay(i.end.date)}</li>)}{/* MOCK-HOOK */}
                        {!roadmap.data?.items.some((i) => i.goal?.id === g.id) && <li>Nothing planned yet. Ask for suggestions below.</li>}{/* MOCK-HOOK */}
                      </ul> // MOCK-HOOK
                    )}{/* MOCK-HOOK */}
                    {g.path && (
                      <span data-testid="home-goal-path" className="simple-small tnum">
                        {g.path}
                      </span>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      <span data-testid="home-goal-status" title={g.why ?? undefined} className={`simple-status ${STATUS_TONE[g.status]}`}>
                        {g.status}
                      </span>
                      {!reads && g.needYou > 0 && (
                        <span className="simple-small" data-testid="home-goal-need">
                          {g.needYou} {g.needYou === 1 ? "item needs" : "items need"} you
                        </span>
                      )}
                    </div>
                    <SuggestionsButton goal={{ id: g.id, key: g.id, title: g.name }} api={suggestions} onOpen={setGoalPanel} className="self-start" />
                  </li>
                ))}
              </ul>
            )
          }
        </Block>
      </section>

      {!reads && (tilesShown.length > 0 || draft) && (
        <section aria-label="Summary" data-testid="home-summary" className="simple-card">
          {tilesShown.length > 0 && (
          <ul className="grid gap-3 max-[600px]:gap-2" style={{ gridTemplateColumns: `repeat(${tilesShown.length}, minmax(0, 1fr))` }}>
            {tilesShown.map(([id, n, label, short]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  data-testid={`home-summary-${id}`}
                  className="flex h-full flex-col rounded-xl bg-surface2 px-4 py-3 hover:bg-accent-soft max-[600px]:px-2.5 max-[600px]:py-2"
                >
                  <span className="simple-number tnum max-[600px]:text-[22px]! max-[600px]:leading-7!">{n ?? "–"}</span>
                  {/* qa-onboarding-20: on a phone the label is its short form, on one line. */}
                  <span className="simple-small max-[600px]:hidden">{label}</span>
                  <span className="simple-small hidden max-[600px]:block max-[600px]:text-[13px]! max-[600px]:leading-4">{short}</span>
                </a>
              </li>
            ))}
          </ul>
          )}
          {draft && (
            <p data-testid="home-draft" className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Your working draft of <strong>{draft.document.title}</strong> has {draft.changes} {draft.changes === 1 ? "change" : "changes"}. It publishes as v
                {(draft.base_version ?? 0) + 1} when{" "}
                {draft.waiting_on.length
                  ? draft.waiting_on.map((id) => nameOf(id, "a reviewer")).join(", ")
                  : "its decider"}{" "}
                {draft.waiting_on.length > 1 ? "approve" : "approves"}.
              </span>
              <Link href={`/simple/roadmap?draft=${draft.id}`} className="simple-button">
                Open draft
              </Link>
            </p>
          )}
        </section>
      )}

      {!reads && quiet && (
        <section aria-label="Waiting for you" data-testid="home-nothing-waits" className="simple-card">
          <p className="simple-small">
            Nothing waits on you.{" "}
            {decidesAll
              ? "Decisions and proposals on your items show here when they come."
              : "You can propose a change from the roadmap, or comment on a one-pager."}{" "}
            <Link href="/simple/roadmap" className="simple-link">
              Open the roadmap
            </Link>
          </p>
        </section>
      )}

      {!reads && !decisionsEmpty && (
        <HomeCard
          id="decisions"
          icon="flag"
          title="Decisions waiting for you"
          all="/simple/decisions"
          allLabel="All decisions"
        >
          <Block q={{ ...decisions, error: waiting.error ?? decisions.error, data: decisionRows }} testId="home-decisions">
            {(rows) =>
              rows.length === 0 ? (
                <p className="simple-small" data-testid="home-decisions-empty">
                  No decision waits on you.
                </p>
              ) : (
                <Top rows={rows} max={phone ? 2 : 3} more="/simple/decisions" what="of the decisions">
                  {(d) =>
                    "code" in d ? (
                      <QuestionRow key={d.id} q={d} mode="list" testId="home-question" actions={questionActions} plain />
                    ) : (
                      <DecisionRow key={d.id} d={d} onDecide={decide} />
                    )
                  }
                </Top>
              )
            }
          </Block>
        </HomeCard>
      )}

      {!reads && !proposalsEmpty && (
        <HomeCard id="proposals" icon="comment" title={proposalTitle} all={REVIEW} allLabel="All proposals">
          <Block q={changes} testId="home-proposals">
            {() =>
              proposalRows.length === 0 ? (
                <p className="simple-small" data-testid="home-proposals-empty">
                  {proposalRows === toDecide ? "When someone suggests a change to your items, it shows here." : "None of your proposals waits."}
                </p>
              ) : (
                <Top rows={proposalRows} more={REVIEW} what="of the proposals">
                  {proposalRow}
                </Top>
              )
            }
          </Block>
        </HomeCard>
      )}

      {!reads && mineApart.length > 0 && (
        <HomeCard id="my-proposals" icon="comment" title="Your proposals waiting" all={REVIEW} allLabel="All your proposals">
          <Block q={changes} testId="home-my-proposals">
            {() => (
              <Top rows={mineApart} more={REVIEW} what="of your proposals">
                {proposalRow}
              </Top>
            )}
          </Block>
        </HomeCard>
      )}

      <HomeCard id="meeting" icon="clock" title="Next review meeting" all="/simple/meetings" allLabel="All meetings">
        <Block q={meeting} testId="home-meeting" skeleton={<SkeletonRows n={1} />}>
          {({ next }) =>
            !next ? (
              <p className="simple-small" data-testid="home-meeting-empty">
                No review meeting scheduled.
              </p>
            ) : (
              <ul className="flex flex-col">
                <HomeRow
                  testId="home-meeting-next"
                  lead={
                    <span className="simple-date-tile tnum" aria-hidden>
                      <span>{formatInZone(next.due_at, zone, { month: "short" })}</span>
                      <strong>{formatInZone(next.due_at, zone, { day: "numeric" })}</strong>
                    </span>
                  }
                  title={next.ritual_title}
                  meta={
                    <>
                      <span className="tnum">
                        {formatInZone(next.due_at, zone, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} · {next.length_min} min
                      </span>
                      <br />
                      {next.attendees.length} {next.attendees.length === 1 ? "attendee" : "attendees"}
                      {next.attendees.length > 0 &&
                        `: ${next.attendees
                          .slice(0, 4)
                          .map((a) => a.name)
                          .join(", ")}`}
                      <br />
                      {next.pre_read_ready && next.occurrence_id ? (
                        <Link className="underline" href={`/simple/meetings?pre_read=${next.occurrence_id}`}>
                          Open pre-read
                        </Link>
                      ) : (
                        "Pre-read not ready yet"
                      )}
                    </>
                  }
                  actions={
                    next.meeting_id ? (
                      <Link href={`/simple/meetings/${next.meeting_id}`} className="simple-button simple-button-primary">
                        Open meeting
                      </Link>
                    ) : next.can_start ? (
                      /* qa-simple-home-27: before its day the start is said as early ("Start now"). */
                      <Link href={`/simple/meetings?start=${next.ritual_id}`} className="simple-button simple-button-primary">
                        {zoneDay(next.due_at) > zoneDay(now.toISOString()) ? "Start now" : "Start review"}
                      </Link>
                    ) : undefined
                  }
                />
              </ul>
            )
          }
        </Block>
      </HomeCard>

      <HomeCard id="plan" icon="roadmap" title="The plan this quarter" all="/simple/roadmap" allLabel="All of the roadmap">
        <Block q={roadmap} testId="home-plan">
          {(r) => (
            <>
              {/* The plan's span, when the PRD's plan dates it ("Nov 2 - Feb 12"). */}
              {r.span && (
                <p className="simple-small" data-testid="home-plan-span">
                  {r.span.label}
                </p>
              )}
              {/* In the plan's card, filled with it: above the goal band it pushed everything down. */}
              {r.changes_in_review > 0 && (
                <p role="status" data-testid="home-in-review" className="rounded-xl bg-warn-bg px-4 py-3 text-warn">
                  {r.changes_in_review === 1
                    ? "1 change is in review. You see the published plan until it is approved."
                    : `${r.changes_in_review} changes are in review. You see the published plan until they are approved.`}
                </p>
              )}
              {planPrd === undefined ? (
                <SkeletonRows />
              ) : plan && planPrd ? (
                <PlanByMonth plan={plan} prd={planPrd} testId="home-strip" named />
              ) : (
                <p className="simple-small" data-testid="home-plan-empty">
                  Nothing planned this quarter yet.
                </p>
              )}
              {broken.length > 0 && (
                <section id="broken-links" aria-labelledby="broken-links-title" data-testid="home-broken-links" className="mt-2 flex scroll-mt-6 flex-col gap-2 border-t border-line pt-4">
                  <h3 id="broken-links-title" className="flex items-center gap-2 font-semibold text-crit">
                    <Icon name="alert" size={18} />
                    <span>
                      Broken links{brokenRoadmaps.length ? ` · ${brokenRoadmaps.join(", ")}` : ""}
                    </span>
                  </h3>
                  {/* qa-simple-home-9: who decides the fixes I may only propose, said once. */}
                  {!reads && brokenDeciders.length > 0 && (
                    <p data-testid="home-broken-deciders" className="simple-small">
                      {joinAnd(brokenDeciders)} {brokenDeciders.length > 1 ? "decide" : "decides"} the fixes you propose here.
                    </p>
                  )}
                  {/* Every broken link the summary counts, never only the first three; one heading per item (qa-simple-home-11). */}
                  <Top rows={brokenByItem} max={brokenByItem.length} more="/simple/roadmap">
                    {(links) => (
                      <HomeRow
                        key={links[0].item.id}
                        testId="home-broken-item"
                        lead={<RowIcon name="alert" />}
                        title={<span className="text-crit">{links[0].item.title}</span>}
                        meta={
                          <ul className="flex flex-col gap-3">
                            {links.map((b) => (
                              <BrokenRow
                                key={`${b.item.id}-${b.flag.kind}-${b.flag.subject}`}
                                b={b}
                                reads={reads}
                                onFix={fix}
                                moves={b.flag.fixes.includes("shift_dependents") ? shiftMoves(b, roadmap.data?.items ?? []) : []}
                                proposed={mine.find((c) => FIX_OPS.has(c.op) && c.target.item_id === b.item.id && (c.target.subject ?? null) === (b.flag.subject ?? null))}
                                nameOf={nameOf}
                              />
                            ))}
                          </ul>
                        }
                      />
                    )}
                  </Top>
                </section>
              )}
            </>
          )}
        </Block>
      </HomeCard>

      {reads ? (
        <>
          <HomeCard id="next-milestone" icon="flag" title="What the next milestone delivers" all="/simple/roadmap" allLabel="All of the roadmap">
            <Block q={roadmap} testId="home-milestone">
              {(r) => {
                const m = r.milestones.filter((x) => x.date && x.date >= r.today && x.status === "planned").sort((a, b) => a.date!.localeCompare(b.date!))[0];
                if (!m) return <p className="simple-small">No milestone ahead yet.</p>;
                return (
                  <Top rows={r.items.filter((i) => m.item_ids.includes(i.id))} more="/simple/roadmap" what="of the items">
                    {(i) => (
                      <HomeRow
                        key={i.id}
                        testId="home-milestone-row"
                        lead={<RowIcon name="roadmap" />}
                        title={
                          <Link href={i.prd ? `/simple/roadmap?prd=${encodeURIComponent(i.prd.slug)}` : `/simple/roadmap?roadmap=${encodeURIComponent(i.roadmap.id)}`} className="hover:underline">
                            {i.title}
                          </Link>
                        }
                        meta={`${m.name} · ${i.outcome ?? i.roadmap.title}`}
                      />
                    )}
                  </Top>
                );
              }}
            </Block>
          </HomeCard>
          <HomeCard id="decided" icon="check" title="Decided lately" all="/simple/decisions" allLabel="All decisions">
            <Block q={decidedLately} testId="home-decided">
              {(rows) =>
                rows.length === 0 ? (
                  <p className="simple-small">Nothing decided yet.</p>
                ) : (
                  <Top rows={[...rows].sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""))} more="/simple/decisions" what="of the decisions">
                    {(d) => (
                      <HomeRow
                        key={d.id}
                        testId="home-decided-row"
                        lead={<RowIcon name="check" />}
                        title={
                          <Link href={`/simple/decisions#d-${d.number}`} className="hover:underline">
                            {d.title}
                          </Link>
                        }
                        meta={d.decided_at ? formatInZone(d.decided_at, zone, { month: "short", day: "numeric" }) : undefined}
                      />
                    )}
                  </Top>
                )
              }
            </Block>
          </HomeCard>
          <HomeCard id="read" icon="doc" title="One-pagers to read" all="/simple/one-pagers" allLabel="All one-pagers">
            <Block q={onePagers} testId="home-read">
              {(rows) =>
                rows.length === 0 ? (
                  <p className="simple-small">No PRDs yet.</p>
                ) : (
                  <Top rows={rows} more="/simple/one-pagers" what="of the one-pagers">
                    {(d) => <HomeRow key={d.id} lead={<RowIcon name="doc" />} title={<Link href={`/simple/one-pagers/${d.slug}`} className="hover:underline">{d.title}</Link>} />}
                  </Top>
                )
              }
            </Block>
          </HomeCard>
        </>
      ) : (
        <HomeCard id="since" icon="clock" title="Since your last visit">
          <Block q={{ ...changes, error: changes.error ?? inbox.error, data: inbox.data && changes.data }} testId="home-since">
            {(rows) => {
              const seen = inbox.data?.last_seen_at ?? null;
              // What changed and stayed: never an undone change nor its undo; mine said as mine ("You moved ...").
              const fresh = rows.filter((c) => c.status !== "proposed" && c.status !== "undone" && !c.undone && !c.undoes_id && (!seen || (c.decided_at ?? c.at) > seen));
              const said = (c: Change) => {
                const words = c.words || `${c.by_name}: ${changeWords(c, roadmap.data?.items.find((i) => i.id === c.target.item_id))}`;
                if (c.by !== myId) return words;
                if (c.words && c.words.startsWith(`${c.by_name} `)) return `You ${c.words.slice(c.by_name.length + 1)}`;
                return c.words ? `You: ${c.words}` : `You: ${changeWords(c, roadmap.data?.items.find((i) => i.id === c.target.item_id))}`;
              };
              const recent = [
                ...fresh.map((c) => ({ key: c.id, at: c.decided_at ?? c.at, icon: "roadmap" as const, title: said(c), who: null, status: null })),
                ...(inbox.data?.decisions ?? [])
                  .filter((d) => (d.reason === "oracle_decided" || d.reason === "informed") && (!seen || d.since > seen))
                  .map((d) => ({ key: d.id, at: d.since, icon: "flag" as const, title: d.title, who: "Decision", status: "decided" })),
              ].sort((a, b) => b.at.localeCompare(a.at));
              return recent.length === 0 ? (
                <p className="simple-small" data-testid="home-since-empty">
                  Nothing changed since your last visit.
                </p>
              ) : (
                <Top rows={recent} max={5} more="/simple/decisions" what="of the changes">
                  {(r) => (
                    <HomeRow
                      key={r.key}
                      testId="home-since-row"
                      lead={<RowIcon name={r.icon} />}
                      title={withoutCodes(r.title)}
                      meta={`${r.who && r.status ? `${r.who} · ${r.status} · ` : ""}${formatInZone(r.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                    />
                  )}
                </Top>
              );
            }}
          </Block>
        </HomeCard>
      )}
      </>
      )}
    </SimplePage>
  );
}

/**
 * Set up (qa-onboarding-4): Detailed Home's checklist on Simple's Home, a welcome and each
 * step, until all are done. Its steps say Detailed's words and figures ("Connect tools · 1
 * connected", qa-onboarding-19), its header a progress ring, not a tick; on a phone the count
 * and Hide sit under the title (qa-onboarding-20). A member who is not an owner sees only their
 * own steps, in their words.
 */
function SetupCard({ setup, owner, onHide }: { setup: Schemas["SetupOut"]; owner: boolean; onHide: () => void }) {
  const count = (
    <>
      <span data-testid="home-setup-progress" className="simple-small tnum whitespace-nowrap">
        {setup.done} of {setup.total} done
      </span>
      <button type="button" className="simple-button simple-button-quiet" onClick={onHide}>
        Hide
      </button>
    </>
  );
  const part = setup.total > 0 ? setup.done / setup.total : 0;
  return (
    <HomeCard
      id="setup"
      icon="check"
      badge={
        <span role="img" aria-label={`${setup.done} of ${setup.total} done`} data-testid="home-setup-ring" className="grid size-9 flex-none place-items-center rounded-full bg-accent-soft">
          <svg viewBox="0 0 36 36" className="size-7 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="4" className="text-line-strong" />
            <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="4" className="text-accent-ink" strokeDasharray={`${(part * 88).toFixed(1)} 88`} strokeLinecap="round" />
          </svg>
        </span>
      }
      title={owner ? "Welcome: set up Oracle" : "Set up your own tools"}
      extra={
        <span data-testid="home-setup-count" className="flex items-center gap-3 max-[600px]:basis-full max-[600px]:pl-12">
          {count}
        </span>
      }
    >
      <p className="simple-small">
        {owner
          ? "A few steps make Oracle yours: connect your tools, pick the sources it reads, then build the baseline it plans from. Each step opens where it is done."
          : "Two steps make Oracle yours: connect your tools and pick the sources it reads for you. Each step opens where it is done."}
      </p>
      <ul className="flex flex-col">
        {setup.steps.map((st) => {
          const copy = copyOf(st);
          const href = SETUP_STEPS[st.key];
          return (
            <HomeRow
              key={st.key}
              testId="home-setup-step"
              lead={
                st.done ? (
                  <span role="img" aria-label="Done" className="grid size-9 place-items-center rounded-full bg-pass-bg text-pass">
                    <Icon name="check" size={20} />
                  </span>
                ) : (
                  <span role="img" aria-label="To do" className="block size-9 rounded-full border-2 border-line-strong" />
                )
              }
              title={
                !st.done && href ? (
                  <Link href={href} className="text-accent-ink hover:underline">
                    {copy.label}
                  </Link>
                ) : (
                  copy.label
                )
              }
              meta={copy.status(st, {})}
            />
          );
        })}
      </ul>
    </HomeCard>
  );
}

/** The dates an item stores (typed or accepted), as the change engine compares them; null for the others. */
function stored(i: Schemas["SimpleRoadmapItem"]) {
  const own = (d: Schemas["SimpleDate"]) => (d.source === "typed" || d.source === "accepted" ? d.date : null);
  return { start_date: own(i.start), end_date: own(i.end) };
}

/** Home's decision rows: the late questions first, then the other judgement calls, then the rest of the questions (soonest first). */
function homeDecisionRows(questions: Question[], others: Decision[]): (Question | Decision)[] {
  return [...questions.filter((q) => q.late), ...others, ...questions.filter((q) => !q.late)];
}

/** A decision waiting for me: Decide with the proposed option, or choose another. */
function DecisionRow({ d, onDecide }: { d: Decision; onDecide: (d: Decision, key: string) => void }) {
  const [other, setOther] = useState(false);
  const proposed = d.options.find((o) => o.recommended) ?? d.options[0];
  return (
    <HomeRow
      testId="home-decision"
      inlineActions
      lead={<RowIcon name="flag" />}
      title={<span title={d.ref ? `${d.ref} · ${d.title}` : undefined}>{d.title}</span>}
      meta={
        <>
          {/* qa-simple-home-13: no code ("D-12") in Simple; the question and the proposal say it. */}
          {[d.question, proposed ? `Proposed: ${proposed.label}` : null].filter(Boolean).join(" · ")}
          {other && (
            <span role="group" aria-label="Other options" className="mt-2 flex flex-wrap gap-2">
              {d.options
                .filter((o) => o.key !== proposed?.key)
                .map((o) => (
                  <button key={o.key} type="button" className="simple-button" onClick={() => onDecide(d, o.key)}>
                    {o.label}
                  </button>
                ))}
            </span>
          )}
        </>
      }
      actions={
        d.can_decide !== false && proposed && d.options.length >= 2 ? (
          <>
            <button type="button" className="simple-button simple-button-primary" onClick={() => onDecide(d, proposed.key)}>
              Decide: {proposed.label}
            </button>
            <button type="button" className="simple-button" aria-expanded={other} onClick={() => setOther((o) => !o)}>
              Choose another option
            </button>
          </>
        ) : (
          <Link href={`/company/decisions?d=${d.number}`} className="simple-button">
            Open
          </Link>
        )
      }
    />
  );
}

/**
 * One problem of a broken item, under the item's heading (qa-simple-home-11): its sentence
 * without the item's name, its one-click fixes (proposals for those who propose) in one row
 * under the sentence (qa-simple-home-9), and what "Move the dependents" moves (qa-simple-home-1).
 * "Accept as risk" asks why, in one line, for every role, under the button's own words
 * (qa-simple-home-10). Once I proposed a fix it says so, and waits, with no second Propose.
 */
function BrokenRow({
  b,
  reads,
  onFix,
  moves,
  proposed,
  nameOf,
}: {
  b: BrokenLink;
  reads: boolean;
  onFix: (b: BrokenLink, op: FixOp, note?: string) => Promise<void>;
  /** The items "Move the dependents" moves, the item first. */
  moves: Schemas["SimpleRoadmapItem"][];
  /** My proposal waiting on this link (GET /v1/simple/changes: proposed, by me, its item and subject). */
  proposed?: Change;
  nameOf: (id: string, fallback: string) => string;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  // The item says whether I decide it and who does (D-a), as a change's can_decide.
  const applies = b.item.can_decide;
  const label = (text: string) => (applies ? text : `Propose: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
  const hintId = `risk-hint-${b.item.id}-${b.flag.subject ?? b.flag.kind}`;
  const moveId = `moves-${b.item.id}-${b.flag.subject ?? b.flag.kind}`;
  const waitingFor = proposed
    ? proposed.routed_to.length
      ? proposed.routed_to.map((id) => nameOf(id, "the decider")).join(", ")
      : b.item.deciders.length
        ? b.item.deciders.join(", ")
        : "the decider"
    : "";
  const showFixes = !reads && !proposed;
  return (
    <li data-testid="home-broken" className="flex flex-col gap-2">
      <span className="text-text">
        <span className="sr-only">{b.item.title}: </span>
        {problemWords(b.flag.reason, b.item.title)}
      </span>
      {proposed && (
        <span data-testid="home-broken-proposed" className="block font-semibold text-text">
          You proposed: {FIX_WORDS[proposed.op as FixOp] ?? OP_WORDS[proposed.op] ?? proposed.op} · waiting for {waitingFor}
        </span>
      )}
      {showFixes && b.flag.fixes.includes("shift_dependents") && b.dependency && moves.length > 0 && (
        <span id={moveId} data-testid="home-broken-moves" className="simple-small">
          Moving the dependents starts {joinAnd(moves.map((m) => m.title))} after {b.dependency.title} ends.
        </span>
      )}
      {showFixes && (
        <span data-testid="home-row-actions" className="flex flex-wrap items-center gap-2">
          {b.flag.fixes.includes("shift_dependents") && (
            <button type="button" className="simple-button" aria-describedby={moveId} onClick={() => void onFix(b, "shift_dependents")}>
              {label(FIX_WORDS.shift_dependents)}
            </button>
          )}
          {b.flag.fixes.includes("move_dependency") && (
            <button type="button" className="simple-button" onClick={() => void onFix(b, "move_dependency")}>
              {label(FIX_WORDS.move_dependency)}
            </button>
          )}
          {/* Open, the reason line takes its place: one button with these words at a time. */}
          {b.flag.fixes.includes("accept_risk") && !noting && (
            <button type="button" className="simple-button" aria-expanded={false} onClick={() => setNoting(true)}>
              {label(FIX_WORDS.accept_risk)}
            </button>
          )}
        </span>
      )}
      {showFixes && noting && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void onFix(b, "accept_risk", note.trim());
          }}
        >
          <input
            aria-label="Why the risk is acceptable"
            aria-describedby={hintId}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why it is acceptable, in one line"
            className="h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-text"
          />
          <button type="submit" className="simple-button simple-button-primary" disabled={!note.trim()}>
            {label(FIX_WORDS.accept_risk)}
          </button>
          <button type="button" className="simple-button simple-button-quiet" onClick={() => setNoting(false)}>
            Cancel
          </button>
          <span id={hintId} data-testid="home-risk-hint" className="simple-small basis-full">
            Say why, in one line, to save it.
          </span>
        </form>
      )}
    </li>
  );
}
