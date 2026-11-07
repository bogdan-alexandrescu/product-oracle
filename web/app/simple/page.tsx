"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { copyOf, setupOpen } from "@/app/home/_setup";
import { Avatar, Block, GoalBandSkeleton, HomeCard, HomeRow, RowIcon, SkeletonRows, Top } from "@/app/simple/_home/cards";
import { Walk } from "@/app/simple/_home/walk";
import { runStopsOf, StopCard } from "@/app/simple/_home/run-stops";
import { SimpleWelcome } from "@/app/simple/_home/welcome";
import { MarkForItem, WithFeatureMarks } from "@/components/current-state/CurrentState";
import { Icon } from "@/components/ds/Icon";
import { Button } from "@/components/ds/Button";
import { InfoTip } from "@/components/ds/InfoTip";
import { Dialog } from "@/components/ds/Dialog";
import { setToastPlace, toast } from "@/components/ds/Toast";
import { LoadError } from "@/components/ui";
import { GoalPanel, SuggestionsButton, useGoalSuggestions, type GoalBrief } from "@/components/simple/GoalSuggestions";
import { usePhone } from "@/components/simple/FlowViews";
import { GoalNum, GoalOrderEdit } from "@/components/simple/GoalOrder";
import { meetingMoment } from "@/components/simple/FlowVisual";
import { NewPrdButton, NewPrdSheet, StartedCard, useCanStartPrd, useStartedPrds } from "@/components/simple/NewPrd";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { DecisionSheetHost, SheetHandle, showOutdated, useDecisionSheet } from "@/components/simple/questions/DecisionSheet";
import { Named } from "./roadmap/_fields";
import { FeaturePanel, useItemChanged } from "./roadmap/_panel";
import { QuestionRow, useQuestionActions, type Question } from "@/components/simple/questions/Questions";
import { SimplePage } from "@/components/simple/SimplePage";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { calendarDay, formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import {
  beforeAfter,
  brokenLinks,
  draftNext,
  changeWords,
  fixChange,
  goalTiles,
  greeting,
  homePlanInputs,
  NEW_FLOW_OPS,
  OP_WORDS,
  opWords,
  planByMonth,
  waitSentence,
  type BrokenLink,
  type FixOp,
  type GoalTile,
} from "@/lib/simple-home";
import { errorMessage, useQuery } from "@/lib/use-query";
import { loadInbox } from "@/lib/waiting";
import { invalidateWaiting, loadWaiting, onWaitingChanged, waitingChanged } from "@/lib/simple-waiting";
import { WAITING_KIND, WaitingRow } from "@/components/simple/WaitingItems";

type Change = Schemas["SimpleChangeOut"];
type Decision = Schemas["DecisionOut"];

/** Where a proposal is reviewed: the roadmap's "Needs a decision" list, at its Proposals part (qa-simple-home-14). */
const REVIEW = "/simple/roadmap?review=proposals";

/** A broken link's one-click fixes, and what each did, in a toast ("Risk accepted in your working draft"). */
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
  build_baseline: "/ground-truth?build=1",
};

/** An item code before a name ("F-06 Weekly alert digest"): Simple says the name alone (qa-simple-home-13). */
const withoutCodes = (text: string) => text.replace(/\b[A-Z]{1,3}-\d{1,4}\s+/g, "");

/**
 * The sentence under a broken link's item, without the item's name the heading already says
 * (qa-simple-home-11; qa4-simple-home-28: quoted straight or curly, or not quoted at all).
 */
function problemWords(reason: string, title: string): string {
  const names = [title, title.length <= 40 ? title : `${title.slice(0, 39)}…`];
  const own = names.flatMap((t) => [`'${t}' `, `‘${t}’ `, `${t} `]).find((p) => reason.startsWith(p));
  const rest = own ? reason.slice(own.length) : reason;
  const plain = rest.replace(/(^|[\s(])'([^']+?)'(?=[\s,.)]|$)/g, "$1$2").replace(/(^|[\s(])‘([^’]+?)’(?=[\s,.)]|$)/g, "$1$2");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const joinAnd = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

/** How often Home reads again while Oracle drafts a new item (backing off), and for how long. */
const DRAFT_READ_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const DRAFT_READS_FOR_MS = 120_000;

/** What else the one list holds beyond the decisions tile, in words, each kind with its number. */
const BESIDES: [Schemas["SimpleWaitingItem"]["kind"], string, string][] = [
  ["run_stop", "run stop", "run stops"],
  ["broken_link", "broken link", "broken links"],
  ["date", "date to confirm", "dates to confirm"],
  ["draft", "draft", "drafts"],
  ["proposal", "proposal", "proposals"],
  ["goal_suggestion", "goal suggestion", "goal suggestions"],
  ["goal", "proposed goal", "proposed goals"],
];
function allBesides(items: Schemas["SimpleWaitingItem"][]): string {
  return joinAnd(
    BESIDES.flatMap(([kind, one, many]) => {
      const n = items.filter((i) => i.kind === kind).length;
      return n ? [`${n} ${n === 1 ? one : many}`] : [];
    }),
  );
}

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
/** An item's dates in a change's before or after. */
type Dates = { start_date?: string | null; end_date?: string | null };

export default function SimpleHome() {
  const { me, can, capsReady } = useMe();
  const zone = useCompanyZone();
  const [stamp, setStamp] = useState(0);
  // one-feature-panel: a feature named on Home opens its panel (the roadmap's).
  const [opened, setOpened] = useState<Schemas["SimpleRoadmapItem"] | null>(null);
  // S9: "Walk me through it" turns Home into a guided pass; Done returns here.
  const [walking, setWalking] = useState(false);
  // qa4-simple-home-10: Done gives the focus back to "Walk me through it".
  const walkButton = useRef<HTMLButtonElement>(null);
  const backToWalk = useRef(false);
  const canStartPrd = useCanStartPrd();
  const [newPrd, setNewPrd] = useState(false);
  const closeNewPrd = useCallback(() => setNewPrd(false), []);
  const started = useStartedPrds(canStartPrd);
  useEffect(() => {
    if (walking || !backToWalk.current) return;
    walkButton.current?.focus();
    if (walkButton.current) backToWalk.current = false;
  });
  const k = (name: string) => `simple-home|${name}|${stamp}`;
  // qa-simple-home-30: Home's toasts sit bottom-left over the rail, clear of the rows' buttons.
  useEffect(() => setToastPlace("rail"), []);
  // home-waiting-one-list: whatever changes what waits on me (an action here, in a row of the one
  // list, or anywhere else) reads Home again, so what was acted on leaves Home with the rail's count.
  useEffect(() => onWaitingChanged(() => setStamp((s) => s + 1)), []);
  const reloadAll = () => {
    invalidateWaiting();
    waitingChanged();
  };
  useItemChanged(reloadAll);

  const inbox = useQuery(k("inbox"), loadInbox, { keepPrevious: true });
  // vqa-simple-runs: Back to Home shows the page as it was left (cacheComponents keeps its
  // state): read everything again, and draw no run stop until the Inbox is read, so a stop just
  // approved on the run's page never shows again. Before paint, so nothing stale flashes.
  // vqa-simple-runs (RD3 a, frame "done"): a question decided on its PRD's card stays in its row,
  // with the answer, who and when, and Undo there (no toast), until Home is left: coming
  // back reads the questions again, so a row decided before shows as the API now has it.
  const [decidedHere, setDecidedHere] = useState<Question[]>([]);
  const shownBefore = useRef(false);
  const [revisit, setRevisit] = useState(false);
  useLayoutEffect(() => {
    if (shownBefore.current) {
      invalidateWaiting();
      setDecidedHere([]);
      setRevisit(true);
      setStamp((s) => s + 1);
    }
    shownBefore.current = true;
  }, []);
  useEffect(() => {
    // Once the Inbox is read again: a later reload (a decision on Home) keeps the cards it has.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (revisit && !inbox.loading) setRevisit(false);
  }, [revisit, inbox.loading]);
  const roadmap = useQuery(k("roadmap"), () => unwrap(api.GET("/v1/simple/roadmap")), { keepPrevious: true });
  // home-waiting-one-list: a goal suggestion confirmed here (or anywhere) adds an item Oracle
  // drafts; its dates to confirm wait on me once that is done, so while one drafts Home, its
  // cards and the rail read again (until it is done).
  // It backs off (1 s, 2 s, 4 s, then every 8 s) and stops after two minutes: a short line then
  // offers Refresh, which starts it again.
  // The stop holds only for the items that were drafting when it came: once they are drafted, a
  // later item (another goal suggestion confirmed) is read again by itself, with no Refresh.
  const draftingIds = (roadmap.data?.items ?? []).filter((i) => i.drafting).map((i) => i.id).sort().join(" ");
  const drafting = !!draftingIds;
  const draftReads = useRef<{ ids: string; since: number; tries: number } | null>(null);
  const [stalledOn, setStalledOn] = useState<string | null>(null);
  const draftStalled = drafting && stalledOn === draftingIds;
  useEffect(() => {
    if (!drafting) {
      draftReads.current = null;
      return;
    }
    if (draftStalled) return;
    if (draftReads.current?.ids !== draftingIds) draftReads.current = { ids: draftingIds, since: Date.now(), tries: 0 };
    const r = draftReads.current;
    const t = window.setTimeout(
      () => {
        if (Date.now() - r.since >= DRAFT_READS_FOR_MS) {
          setStalledOn(r.ids);
          return;
        }
        r.tries += 1;
        invalidateWaiting();
        waitingChanged();
      },
      DRAFT_READ_DELAYS_MS[Math.min(r.tries, DRAFT_READ_DELAYS_MS.length - 1)],
    );
    return () => window.clearTimeout(t);
  }, [drafting, draftingIds, draftStalled, roadmap.data]);
  const refreshDrafting = () => {
    draftReads.current = null;
    setStalledOn(null);
    reloadAll();
  };
  const goals = useQuery(k("goals"), () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })), { keepPrevious: true });
  const changes = useQuery(k("changes"), () => unwrap(api.GET("/v1/simple/changes")), { keepPrevious: true });
  const drafts = useQuery(k("drafts"), () => unwrap(api.GET("/v1/simple/drafts")), { keepPrevious: true });
  // prd-questions: the one list of product decisions waiting for me (GET /v1/simple/decisions/waiting):
  // its count, its late count and the PRDs' questions; then the other judgement calls from the
  // Inbox, never Oracle's run approvals (class checkpoint) nor a PRD's question read twice.
  // home-waiting-one-list: the one list of what waits on me, shared with Decisions and the rail.
  const waiting = useQuery(k("waiting"), loadWaiting, { keepPrevious: true });
  // home-waiting-one-list: the decision-log calls proposed to me, from the one list (kind
  // "decision"), so this card and its tile count what Decisions and the rail count.
  const decisions = useQuery(
    k("decisions"),
    async (): Promise<Decision[]> => {
      const rows = (await loadWaiting()).items.filter((i) => i.kind === "decision");
      return Promise.all(rows.map((i) => unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: i.ref_id } } }))));
    },
    { keepPrevious: true },
  );
  const questionActions = useQuestionActions(reloadAll);
  const prdActions: typeof questionActions = {
    ...questionActions,
    decide: async (q, a) => {
      const r = await questionActions.decide(q, a, true);
      // Only when it can be undone: otherwise the toast says it and the row goes as on any list.
      if (r && r.change.status !== "proposed" && r.change.can_undo) {
        const label = [r.words, me?.name, meetingMoment(new Date().toISOString(), zone)].filter(Boolean).join(" · ");
        setDecidedHere((d) => [...d.filter((x) => x.id !== q.id), { ...q, column: "decided", chosen: r.words, decided_label: label, undo_id: r.change.id }]);
      }
      return r;
    },
    undo: async (id) => {
      await questionActions.undo(id);
      setDecidedHere((d) => d.filter((x) => x.undo_id !== id));
    },
  };
  // A4: a phone's Home shows the soonest two decisions, a desktop's three.
  const phone = usePhone();
  // The one list of scheduled reviews (Meetings > Upcoming): its first row is the next.
  const meeting = useQuery(k("meeting"), async () => {
    const list = await unwrap(api.GET("/v1/simple/meetings"));
    return { next: list.upcoming[0] ?? null };
  });
  const personIds = useMemo(() => {
    const ids = new Set<string>((drafts.data ?? []).flatMap((d) => [...d.waiting_on, ...(d.required_reviewers ?? [])]));
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
  // F-28: a hidden Set up comes back from Home's menu.
  const setupHidden = can("get_setup") && setupOpen(setupQ.data) && setupQ.data.hidden ? setupQ.data : null;
  async function hideSetup(hidden = true) {
    try {
      await unwrap(api.PATCH("/v1/me/preferences", { body: { setup_hidden: hidden } }));
      // Round 2: the toast says what happened, with Show; no how-to sentence.
      if (hidden) toast({ message: "Set up hidden", action: { label: "Show", onClick: () => void hideSetup(false) } });
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    void setupQ.reload();
  }
  const decidedLately = useQuery(k("decided"), () => unwrap(api.GET("/v1/decisions", { params: { query: { status: "decided" } } })));
  const onePagers = useQuery(k("one-pagers"), () => unwrap(api.GET("/v1/simple/one-pagers")));

  // S7: Oracle's suggested features under each goal of the band (an accept reloads Home).
  const suggestions = useGoalSuggestions(reloadAll);
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
  // A proposal that moves dates: its Accept first lists what moves (old and new dates).
  const [confirming, setConfirming] = useState<Change | null>(null);
  const proposes = can("create_simple_change");
  const decidesAll = can("accept_simple_change");
  const reads = !proposes;
  const myId = me?.user_id ?? "";

  // A goal's ask (Ask to archive, delete or restore) names no roadmap item, so the roadmap's
  // proposals tray behind "more" cannot list it: it comes first here.
  const toDecide = useMemo(() => {
    const rows = (changes.data ?? []).filter((c) => c.status === "proposed" && c.can_decide);
    return [...rows.filter((c) => typeof c.target.goal_id === "string"), ...rows.filter((c) => typeof c.target.goal_id !== "string")];
  }, [changes.data]);
  const mine = useMemo(() => (changes.data ?? []).filter((c) => c.status === "proposed" && c.by === myId), [changes.data, myId]);
  const broken = useMemo(() => brokenLinks(roadmap.data), [roadmap.data]);
  const waitingItems = useMemo(() => {
    const ids = new Set<string>();
    for (const c of toDecide) if (typeof c.target.item_id === "string") ids.add(c.target.item_id);
    for (const b of broken) if (b.item.can_decide) ids.add(b.item.id);
    return ids;
  }, [toDecide, broken]);
  const proposedGoals = (goals.data ?? []).filter((g) => g.type === "goal" && g.status === "proposed");
  // build-goal-order-control: Change order turns the row into the numbered one (owners and approvers).
  const [ordering, setOrdering] = useState(false);
  const canOrder = can("update_entity");
  const tiles = useMemo(() => (goals.data ? goalTiles(goals.data, roadmap.data, waitingItems) : undefined), [goals.data, roadmap.data, waitingItems]);
  // A new company (no goals yet) leads with its setup; an established company's Simple Home keeps
  // its picked design (Detailed Home keeps the checklist behind its Set up chip).
  const setupFirst = !!setup && tiles !== undefined && tiles.length === 0;
  // home-waiting-one-list: the plan is the company roadmap's (GET /v1/simple/roadmap reads only
  // it once there is one: oracle.roadmap.company feeding_ids), every PRD's items in the
  // roadmap's own milestones by name, never one PRD's plan milestones; home-milestones-current:
  // its current ones only, as the Simple roadmap's lanes find them (homePlanInputs).
  const plan = useMemo(
    () => (roadmap.data ? planByMonth(homePlanInputs(roadmap.data), roadmap.data.today, roadmap.data.windows.now.end) : null),
    [roadmap.data],
  );
  // qa4-simple-home-12: every working draft of mine, each with its own count (one roadmap's draft never hides another's).
  // home-draft-in-review: a draft sent for review shows to whoever approves it (its can_approve) and
  // to the one who sent or wrote it, until it is decided.
  const myDrafts = (drafts.data ?? []).filter((d) =>
    d.status === "working"
      ? d.changes > 0 && (d.created_by === myId || d.participant_ids.includes(myId))
      : d.status === "submitted" && (d.can_approve || d.submitted_by === myId || d.created_by === myId),
  );
  const proposalRows = toDecide.length > 0 || decidesAll ? toDecide : mine;
  const proposalTitle = toDecide.length > 0 || decidesAll ? "Proposals on your items" : "Your proposals waiting";
  // A decider's own proposals on items others decide wait too: their own card.
  const mineApart = proposalRows === toDecide ? mine : [];
  const itemTitle = (id: unknown) => roadmap.data?.items.find((i) => i.id === id)?.title ?? "An item";
  // A decision sheet's suggestion names its decision ("D-5 Ship usage caps…"), not an item.
  const targetTitle = (c: Change) => (c.target.item_id || typeof c.target.name !== "string" ? itemTitle(c.target.item_id) : c.target.name);
  const sheetRef = useRef<ReturnType<typeof useDecisionSheet>>(null);

  const now = new Date();
  /** A moment's day in the company zone, comparable ("2026-10-30"). */
  const zoneDay = (iso: string) => formatInZone(iso, zone, { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2");
  /** Whether a moment falls in this year, in the company zone. */
  const sameYear = (iso: string) => formatInZone(iso, zone, { year: "numeric" }) === formatInZone(now.toISOString(), zone, { year: "numeric" });
  const hour = Number(formatInZone(now.toISOString(), zone, { hour: "numeric", hourCycle: "h23" }).replace(/\D.*$/, "")) || 9;
  // A person with no name is greeted plainly, never by their email's local part.
  const firstName = (me?.name ?? "").trim().split(/\s/)[0];
  const decisionCount = waiting.data?.count ?? 0;
  // SW1: the run stops that wait on me, a card each under the summary (their work is on the run's page).
  // home-waiting-one-list: a stop shows while the one list holds it (acted on anywhere, it leaves).
  const waitKeys = waiting.data ? new Set(waiting.data.items.map((i) => i.key)) : undefined;
  const runStops = revisit && inbox.loading ? undefined : runStopsOf(inbox.data)?.filter((s) => !waitKeys || waitKeys.has(`run_stop:${s.id}`));
  // What else waits on me and has no card of its own here: drafts for my approval, dates to
  // confirm and goal suggestions I decide, each with its action in place.
  // home-draft-in-review: a draft the drafts card shows lives only there (Home only; other pages keep their rows).
  const draftIds = new Set(myDrafts.map((d) => d.id));
  const alsoWaiting = (waiting.data?.items ?? []).filter(
    (i) => (i.kind === "draft" && !draftIds.has(i.ref_id)) || i.kind === "goal_suggestion" || (i.kind === "date" && !i.op),
  );
  const stopCount = runStops?.length ?? 0;
  // walkc-roadmap-tasks: the open tasks on roadmap items that wait on me.
  const myTasks = waiting.data?.tasks ?? [];
  // Every broken link the tile counts: those I decide wait on me, the others I may propose fixes for.
  const brokenMine = broken.filter((b) => b.item.can_decide).length;
  const brokenOthers = broken.length - brokenMine;
  const waits = waitSentence([
    [decisionCount, "decision", "decisions"],
    [proposalRows === toDecide ? toDecide.length : 0, "proposal", "proposals"],
    [brokenMine, "broken link", "broken links"],
    [stopCount, "run", "runs"],
    [myTasks.length, "task", "tasks"],
  ]);
  const brokenWords = brokenOthers === 1 ? "a broken link" : "broken links";
  // home-honest-loading: what waits is said only once every source it counts has answered
  // (the role, the decisions and tasks, the proposals, the roadmap's links, the run stops).
  const answered = (q: { data?: unknown; error?: unknown }) => q.data !== undefined || !!q.error;
  const known = capsReady && (reads || ([waiting, changes, roadmap, inbox].every(answered) && runStops !== undefined));
  const sentence = !known
    ? "Checking what waits on you…"
    : reads
    ? "Here is where the plan stands."
    : brokenOthers === 0
      ? waits
      : brokenMine + decisionCount + stopCount + myTasks.length + (proposalRows === toDecide ? toDecide.length : 0) === 0
        ? `You can propose fixes for ${brokenWords}.`
        : `${waits} You can also propose fixes for ${brokenWords}.`;
  // Nothing waits and no review is due (a new company): no walk to offer. Unknown until its reads answer.
  const counted = [waiting, changes, roadmap, meeting, inbox].every((q) => q.data !== undefined || !!q.error);
  const nothingToWalk = counted && stopCount + decisionCount + toDecide.length + mine.length + broken.length + myTasks.length === 0 && !meeting.data?.next;
  // qa-simple-home-16: nothing waits on me (no decision, no proposal): one line, not two empty cards and two 0 tiles.
  // An empty section alone is not shown either (its tile neither): the cards that wait on me lead.
  // build-rundecide RD3 a: the PRDs' questions I own wait in a card per PRD; this card keeps the other judgement calls.
  const decisionRows = waiting.data && decisions.data ? homeDecisionRows([], decisions.data) : undefined;
  const prdWaiting = waitingByPrd([...(waiting.data?.questions ?? []).filter((q) => !decidedHere.some((d) => d.id === q.id)), ...decidedHere]);
  const decisionsEmpty = decisionRows !== undefined && decisionRows.length === 0;
  const proposalsEmpty = !!changes.data && proposalRows.length === 0;
  const quiet = !(revisit && inbox.loading) && decisionsEmpty && prdWaiting.length === 0 && proposalsEmpty && mineApart.length === 0 && stopCount === 0 && myTasks.length === 0 && alsoWaiting.length === 0;
  // qa-onboarding-21: a tile that cannot apply yet (no roadmap items, so no links to break) is not shown.
  const tilesShown = (
    [
      // qa4-simple-home-25: one is said in the singular ("1 proposal on your items").
      ["decisions", waiting.data ? decisionCount : null, decisionCount === 1 ? "decision waiting for you" : "decisions waiting for you", decisionCount === 1 ? "decision" : "decisions"],
      [
        "proposals",
        changes.data ? proposalRows.length : null,
        proposalRows === toDecide ? (proposalRows.length === 1 ? "proposal on your items" : "proposals on your items") : proposalRows.length === 1 ? "of your proposals waits" : "of your proposals waiting",
        proposalRows.length === 1 ? "proposal" : "proposals",
      ],
      // home-waiting-one-list: only the links on items I decide wait on me (the one list's and the
      // Roadmap count's); one who decides none of them reads those they can propose fixes for, said so.
      brokenMine > 0 || brokenOthers === 0
        ? (["broken-links", roadmap.data ? brokenMine : null, brokenMine === 1 ? "broken link" : "broken links", brokenMine === 1 ? "broken link" : "broken links"] as const)
        : (["broken-links", brokenOthers, brokenOthers === 1 ? "broken link you can propose a fix for" : "broken links you can propose fixes for", brokenOthers === 1 ? "fix to propose" : "fixes to propose"] as const),
    ] as const
  ).filter(([id]) => (id === "broken-links" ? (roadmap.data?.items.length ?? 1) > 0 : id === "decisions" ? !decisionsEmpty || prdWaiting.length > 0 : !proposalsEmpty));
  // The tiles show once each of their counts is read (or failed): never a 0 or a "–" that later changes.
  const tilesReady = [waiting, decisions, changes, roadmap, drafts].every((q) => q.data !== undefined || !!q.error);
  // build-rundecide review: with no other judgement call the Decisions card is not drawn; its tile goes to the first PRD's card.
  const tileAnchor = (id: string) => (id === "decisions" && decisionsEmpty && prdWaiting[0] ? `waiting-${prdWaiting[0].prd.slug}` : id);
  // The goal band's weights as their share of the score ("50% of the score").
  const weightSum = (tiles ?? []).reduce((n, g) => n + (g.weight != null && g.weight > 0 ? g.weight : 0), 0);
  const share = (w: number | null) => (w != null && w > 0 && weightSum > 0 ? Math.round((w / weightSum) * 100) : null);
  // The broken-links list's heading names the roadmaps they are on.
  const brokenRoadmaps = [...new Set(broken.map((b) => b.item.roadmap.title))];
  const brokenByItem = useMemo(() => {
    const by = new Map<string, BrokenLink[]>();
    for (const b of broken) by.set(b.item.id, [...(by.get(b.item.id) ?? []), b]);
    return [...by.values()];
  }, [broken]);
  // qa4-simple-home-5: links whose "Move the dependents" moves the same items after the same
  // dependency are one move: its control and sentence sit under the first; the others point to it.
  const shiftKey = (b: BrokenLink) => (b.flag.fixes.includes("shift_dependents") && b.dependency ? `${b.dependency.id}|${[...(b.flag.moves ?? [])].sort().join(",")}` : null);
  const shiftLeader = new Map<string, BrokenLink>();
  for (const b of broken) {
    const key = shiftKey(b);
    if (key && !shiftLeader.has(key)) shiftLeader.set(key, b);
  }
  const movedWith = (b: BrokenLink): BrokenLink | undefined => {
    const key = shiftKey(b);
    const lead = key ? shiftLeader.get(key) : undefined;
    return lead && lead !== b ? lead : undefined;
  };
  /** qa4-simple-home-18: my proposal moving this item's dependents already, made on another item it moves. */
  const coveredBy = (b: BrokenLink): Change | undefined =>
    mine.find((c) => c.op === "shift_dependents" && c.target.item_id !== b.item.id && (b.flag.moves ?? []).includes(String(c.target.item_id)) && b.flag.fixes.includes("shift_dependents"));
  const brokenDeciders = [...new Set(broken.filter((b) => !b.item.can_decide).flatMap((b) => (b.item.deciders.length ? b.item.deciders : ["the decider"])))];

  /** What a keyed change moves, item by item: its dates before and after. */
  const moves = (c: Change) =>
    Object.entries(c.after as Record<string, unknown>)
      .filter(([, v]) => !!v && typeof v === "object" && "start_date" in (v as object))
      .map(([id, v]) => {
        const a = v as Dates;
        const b = ((c.before as Record<string, unknown>)[id] ?? {}) as Dates;
        const span = (x: Dates) => (!x.start_date && !x.end_date ? "not dated yet" : `${x.start_date ? calendarDay(x.start_date) : "undated"} – ${x.end_date ? calendarDay(x.end_date) : "undated"}`);
        return { id, title: itemTitle(id), before: span(b), after: span(a) };
      });
  const accepted = (c: Change) => {
    const m = moves(c);
    return m.length ? `Accepted: ${m.map((x) => `${x.title} now ${x.after}`).join("; ")}` : "Accepted";
  };
  const accept = (c: Change) =>
    void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: c.id } } })), accepted(c), (e) =>
      showOutdated(sheetRef.current, e, c.id, String(c.target.name ?? "")),
    );
  const proposalRow = (c: Change) => (
    <HomeRow
      key={c.id}
      testId="home-proposal"
      lead={<Avatar name={c.by_name} />}
      title={`${opWords(c.op)}: ${typeof c.target.goal_id === "string" && typeof c.target.title === "string" ? c.target.title : targetTitle(c)}${typeof c.after.title === "string" && NEW_FLOW_OPS.has(c.op) ? ` · ${c.after.title}` : ""}`}
      meta={`${c.by === myId ? "You" : c.by_name} · ${formatInZone(c.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${c.reason ? ` · ${c.reason}` : ""}`}
      change={NEW_FLOW_OPS.has(c.op) ? null : beforeAfter(c)}
      thumb={NEW_FLOW_OPS.has(c.op)}
      inlineActions
      actions={
        c.can_decide ? (
          <>
            <button
              type="button"
              className="simple-button simple-button-primary"
              onClick={() => (moves(c).length > 0 ? setConfirming(c) : accept(c))}
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

  /** `refused`: shows a refusal elsewhere (true), instead of the toast. */
  async function act(run: () => Promise<unknown>, done: string, refused?: (e: unknown) => Promise<boolean>) {
    try {
      await run();
      toast({ message: done });
    } catch (e) {
      if (!(await refused?.(e))) toast({ message: errorMessage(e) });
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
    const body = fixChange(b, op, note);
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
      // qa4-simple-home-11: the item named once ("Weekly alert digest ends Dec 21, after …").
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
      {/* eq2 b: the question titles on Home open the same decision sheet as on Decisions. */}
      <DecisionSheetHost onChanged={reloadAll}>
      <SheetHandle sheetRef={sheetRef} />
      {opened && (
        <FeaturePanel
          key={opened.id}
          feature={{ id: opened.id, code: opened.code ?? "", name: opened.title, prd: opened.prd }}
          phone={phone}
          canChange={can("create_simple_change")}
          onClose={() => {
            setOpened(null);
            void roadmap.reload();
          }}
        />
      )}
      {newPrd && <NewPrdSheet onClose={closeNewPrd} onStarted={() => void started.reload()} />}
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} onClose={() => setGoalPanel(null)} />}
      {confirming && (
        <Dialog
          title={`Accept: ${opWords(confirming.op)}`}
          testId="accept-moves"
          onClose={() => setConfirming(null)}
          actions={
            <button
              type="button"
              className="simple-button simple-button-primary"
              onClick={() => {
                const c = confirming;
                setConfirming(null);
                accept(c);
              }}
            >
              {`Accept and move ${moves(confirming).length} ${moves(confirming).length === 1 ? "item" : "items"}`}
            </button>
          }
        >
          <p className="simple-small">
            {confirming.by_name} proposed this{confirming.reason ? `: “${confirming.reason}”` : "."} These dates change:
          </p>
          <ul className="simple-small mt-1 flex flex-col gap-1" data-testid="accept-moves-list">
            {moves(confirming).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-text">{m.title}</span>
                <del className="rounded bg-crit-bg px-1.5 text-crit">{m.before}</del>
                <span aria-hidden>→</span>
                <ins className="rounded bg-pass-bg px-1.5 text-pass no-underline">{m.after}</ins>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      <header data-testid="home-greeting" className="-mt-4 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <p className="simple-small tnum">{formatInZone(now.toISOString(), zone, { weekday: "long", month: "long", day: "numeric" })}</p>
          {/* F-28, the owner's pick (Nov 5): a hidden Set up comes back from Home's menu. */}
          {setupHidden && <HomeMenu onShowSetup={() => void hideSetup(false)} />}
        </div>
        <p className="simple-lead max-[600px]:min-h-[2lh]">
          {greeting(hour)}
          {firstName ? `, ${firstName}` : ""}. <span data-testid="home-sentence">{sentence}</span>
        </p>
        {/* NP1: New PRD beside the walk, opening the guided sheet. home-honest-loading: while the
            role or what waits is unknown, each button's place is kept (invisible), so New PRD
            never moves under the pointer as the walk arrives. New PRD itself shows once Home knows
            whether the walk does: with nothing to walk it is first painted where it stays. */}
        {!walking && (!capsReady || !reads || canStartPrd) && (
          <div className="flex flex-wrap gap-2">
            {!capsReady || (!reads && !counted) ? (
              <span aria-hidden data-testid="home-walk-slot" className="simple-button invisible">
                Walk me through it
              </span>
            ) : (
              !reads &&
              !nothingToWalk && (
                <button type="button" ref={walkButton} className="simple-button simple-button-primary" onClick={() => setWalking(true)}>
                  Walk me through it
                </button>
              )
            )}
            {canStartPrd && (reads || counted) ? (
              <NewPrdButton onOpen={() => setNewPrd(true)} />
            ) : (
              (!capsReady || canStartPrd) && (
                <span aria-hidden data-testid="home-new-prd-slot" className="simple-button invisible">
                  <Icon name="plus" size={18} /> New PRD
                </span>
              )
            )}
          </div>
        )}
      </header>

      {walking && (
        <Walk
          onDone={() => {
            backToWalk.current = true;
            setWalking(false);
            reloadAll();
          }}
        />
      )}

      {!walking && (
      <>
      <StartedCard started={started.data ?? []} />
      {/* qa-onboarding-6: an invited member's role welcome, in Simple too (dismissed in one mode, gone in both). */}
      <SimpleWelcome show={setupQ.data?.welcome === true} onDismissed={() => void setupQ.reload()} />
      {setupFirst && setup && (can("put_setting") || !setupQ.data?.welcome) && <SetupCard setup={setup} owner={can("put_setting")} onHide={() => void hideSetup()} />}
      {/* F-8: a Set up that failed to load says so, with Try again, never vanishes; Detailed's error
          note. A viewer has no Set up steps (they cannot add sources), so is not told. */}
      {can("get_setup") && can("create_source") && setupQ.error && !setupQ.data && tiles !== undefined && tiles.length === 0 && (
        <LoadError what="Set up" error={setupQ.error} onRetry={() => void setupQ.reload()} />
      )}

      <section aria-label="Goals" data-testid="home-goals">
        {canOrder && !ordering && (tiles?.length ?? 0) > 1 && (
          <div className="mb-2 flex justify-end">
            <Button variant="ghost" onClick={() => setOrdering(true)} data-testid="goal-order-open">
              Change order
            </Button>
          </div>
        )}
        <Block q={{ ...goals, data: tiles }} testId="home-goals" skeleton={<GoalBandSkeleton />}>
          {(rows) =>
            ordering && rows.length > 0 ? (
              <GoalOrderEdit
                rows={rows}
                positions={new Map((goals.data ?? []).filter((g) => g.type === "goal").map((g) => [g.id, g.position ?? null]))}
                archived={(goals.data ?? []).filter((g) => g.type === "goal" && g.status === "rejected" && !g.parent_id).length}
                onDone={() => setOrdering(false)}
                onSaved={() => void goals.reload()}
              />
            ) : rows.length === 0 ? (
              <p className="simple-small" data-testid="home-goals-empty">
                No confirmed company goals yet.
              </p>
            ) : (
              <ul className="simple-goal-band">
                {rows.map((g, i) => (
                  <li key={g.id} data-testid="home-goal" className="simple-goal">
                    {/* With Ask open the cards narrow: the guardrail tag and the share each keep one line, the share moving under. */}
                    {(g.guardrail || share(g.weight) != null) && (
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {g.guardrail && <span className="simple-tag">guardrail</span>}
                        {share(g.weight) != null && (
                          // pre-demo QA S-10: the share in short, what it means behind its (i).
                          <span className="inline-flex items-center gap-1">
                            <span data-testid="home-goal-weight" className="simple-small tnum">
                              {share(g.weight)}% of the score
                            </span>
                            <InfoTip label="the goal's share of the score" align="start">
                              Counts for {share(g.weight)}% of each feature&apos;s score.
                            </InfoTip>
                          </span>
                        )}
                      </div>
                    )}
                    {/* A goal card opens Priorities filtered to that goal (its key; the name only says which); its code (qa-simple-home-13) only in the tooltip. */}
                    {/* build-goal-order-control: the goal's number sits before its name, outside the link's words. */}
                    <span>
                      <GoalNum n={i + 1} />
                      <Link
                        href={`/simple/priorities?goal=${encodeURIComponent(g.key)}&name=${encodeURIComponent(g.name)}`}
                        data-testid="home-goal-link"
                        title={g.code ? `${g.code} · ${g.name}` : g.name}
                        className="font-semibold text-text hover:underline"
                      >
                        {g.name}
                      </Link>
                    </span>
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
                      {/* goal-map-scoreboard: the goal on the Goal map, the scoreboard of its gates. */}
                      <Link
                        href={`/simple/goals?goal=${encodeURIComponent(g.id)}&name=${encodeURIComponent(g.name)}`}
                        data-testid="home-goal-map"
                        aria-label={`${g.name} on the Goal map`}
                        className="simple-small font-semibold text-accent-ink hover:underline"
                      >
                        Goal map
                      </Link>
                    </div>
                    <SuggestionsButton goal={{ id: g.id, key: g.id, title: g.name }} api={suggestions} onOpen={setGoalPanel} className="self-start" />
                  </li>
                ))}
              </ul>
            )
          }
        </Block>
        {/* qa4-simple-home-6: a goal still proposed is not on Home: said, so Detailed's extra goal is no surprise. */}
        {proposedGoals.length > 0 && (
          <div data-testid="home-goals-proposed-list" className="simple-small mt-2">
            {/* pre-demo QA S-10: the count in short, why it is not on Home behind its (i). */}
            <p className="flex items-center gap-1">
              <span data-testid="home-goals-proposed">{proposedGoals.length === 1 ? "1 proposed goal" : `${proposedGoals.length} proposed goals`}</span>
              <InfoTip label="proposed goals" align="start">
                {proposedGoals.length === 1 ? "It is not shown here until it is confirmed." : "They are not shown here until they are confirmed."}
                {!can("confirm_entity") && " The goal's owner confirms it."}
              </InfoTip>
            </p>
            {/* home-waiting-one-list: each proposed goal, with Confirm / Not this for who confirms goals. */}
            <ul className="mt-1" aria-label="Proposed goals">
              {proposedGoals.map((g) => (
                // Read as Decisions reads it (WaitingRow): "Proposed goal · <name>", Confirm and Not this.
                <li key={g.id} data-testid="home-goal-proposed" aria-label={`${WAITING_KIND.goal}: ${g.title}`} className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0">
                  <span className="min-w-0 flex-1 break-words">
                    <span className="text-text2">{WAITING_KIND.goal} · </span>
                    {g.title}
                  </span>
                  {can("confirm_entity") && (
                    <span className="flex gap-2">
                      <button type="button" className="simple-button simple-button-primary" onClick={() => void act(() => unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", { params: { path: { entity_id: g.id } } })), `${g.title} confirmed`)}>
                        Confirm
                      </button>
                      <button type="button" className="simple-button" onClick={() => void act(() => unwrap(api.POST("/v1/baseline/entities/{entity_id}/reject", { params: { path: { entity_id: g.id } } })), `${g.title} set aside`)}>
                        Not this
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* home-waiting-one-list: until every count is read the tiles say they are loading, never a 0 that is not true. */}
      {!reads && !tilesReady && (
        <section aria-label="Summary" aria-busy="true" data-testid="home-summary-loading" className="simple-card">
          <ul role="status" aria-label="Loading what waits on you" className="grid grid-cols-3 gap-3 max-[600px]:gap-2">
            {[0, 1, 2].map((i) => (
              <li key={i} aria-hidden className="flex h-[76px] flex-col gap-2 rounded-xl bg-surface2 px-4 py-3 max-[600px]:h-[60px] max-[600px]:px-2.5 max-[600px]:py-2">
                <span className="h-6 w-8 animate-pulse rounded bg-line" />
                <span className="h-3 w-24 max-w-full animate-pulse rounded bg-line" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {!reads && tilesReady && (tilesShown.length > 0 || myDrafts.length > 0) && (
        <section aria-label="Summary" data-testid="home-summary" className="simple-card">
          {tilesShown.length > 0 && (
          // qa4-simple-home-17: a lone tile keeps a third of the card; two or three share it as built.
          <ul className="grid gap-3 max-[600px]:gap-2" style={{ gridTemplateColumns: `repeat(${tilesShown.length === 1 ? 3 : tilesShown.length}, minmax(0, 1fr))` }}>
            {tilesShown.map(([id, n, label, short]) => (
              <li key={id}>
                <a
                  href={`#${tileAnchor(id)}`}
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
          {/* home-waiting-one-list: the decisions tile counts the questions and calls I decide; the
           * rail's Decisions count is everything in the one list. Said plainly when they differ. */}
          {waiting.data && waiting.data.items.length !== decisionCount && allBesides(waiting.data.items) && (
            <p data-testid="home-summary-all" className="simple-small mt-2">
              <Link href="/simple/decisions" className="simple-link">
                {waiting.data.items.length} in all
              </Link>{" "}
              <InfoTip label="what waits on you" align="start">
                In all, {waiting.data.items.length} {waiting.data.items.length === 1 ? "thing waits" : "things wait"} on you: the Decisions count also counts {allBesides(waiting.data.items)}.
              </InfoTip>
            </p>
          )}
          {myDrafts.map((draft) => (
            <p key={draft.id} data-testid="home-draft" data-status={draft.status} className="flex flex-wrap items-center justify-between gap-3">
              {/* roadmap-decide: what happens next and who acts, as the roadmap's banner says it (draftNext).
                  home-draft-in-review: sent, its status word; whom it waits on is in the tip. */}
              {draft.status === "submitted" ? (
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <strong>{draft.document.title}</strong> ·{" "}
                  {draft.can_approve ? (
                    "Waiting for your approval"
                  ) : (
                    <InfoTip label="who it waits on" align="start" testId="home-draft-waits" trigger={<span className="simple-link">Waiting for review</span>}>
                      {draftNext(draft, (id) => nameOf(id, "a reviewer")).words}.
                    </InfoTip>
                  )}
                </span>
              ) : (
                <span>
                  Your working draft of <strong>{draft.document.title}</strong> has {draft.changes} {draft.changes === 1 ? "change" : "changes"}.{" "}
                  {draftNext(draft, (id) => nameOf(id, "a reviewer")).words}.
                </span>
              )}
              <Link href={`/simple/roadmap?draft=${draft.id}`} className="simple-button">
                {draftNext(draft).action === "approve" || draftNext(draft).action === "publish" ? "Open draft to approve" : draftNext(draft).action === "submit" ? "Open draft to send for review" : "Open draft"}
              </Link>
            </p>
          ))}
        </section>
      )}

      {runStops?.map((s) => <StopCard key={s.id} s={s} />)}

      {!reads && quiet && (
        <section aria-label="Waiting for you" data-testid="home-nothing-waits" className="simple-card">
          {/* qa4-simple-home-17: the same message as the greeting when broken links are open to proposals. */}
          {brokenOthers > 0 ? (
            <p className="simple-small">
              Nothing waits on you. You can propose fixes for {brokenWords} in the plan below.{" "}
              <a href="#broken-links" className="simple-link">
                Go to the broken links
              </a>
            </p>
          ) : (
            // F-30: one short line; what comes here is in its (i).
            <p className="simple-small flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>Nothing waiting</span>
              <InfoTip label="what waits for you" align="start">
                {decidesAll ? "Decisions and proposals on your items show here when they come." : "You can propose a change from the roadmap, or comment on a one-pager."}
              </InfoTip>
              <Link href="/simple/roadmap" className="simple-link ml-1.5">
                Open the roadmap
              </Link>
            </p>
          )}
        </section>
      )}

      {!reads &&
        prdWaiting.map(({ prd, questions }) => (
          <section key={prd.slug} id={`waiting-${prd.slug}`} className="simple-card scroll-mt-6" aria-label={`Waiting for you: ${prd.title}`} data-testid="home-prd-waiting">
            <header className="flex flex-wrap items-baseline gap-x-3">
              <h2 className="simple-h2 flex-1">Waiting for you: {prd.title}</h2>
              <span className="simple-meta">
                {questions.length} {questions.length === 1 ? "decision" : "decisions"} you own · also on its review meeting&apos;s agenda
              </span>
            </header>
            <div className="mt-3">
              <Top rows={questions} max={phone ? 2 : 3} more={`/simple/decisions?prd=${encodeURIComponent(prd.slug)}`} what={`of ${prd.title}'s decisions`}>
                {(q) => <QuestionRow key={q.id} q={q} mode={decidedHere.includes(q) ? "here" : "list"} testId="home-question" actions={prdActions} plain />}
              </Top>
            </div>
          </section>
        ))}
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

      {drafting && draftStalled && (
        <p data-testid="home-drafting-slow" className="simple-card simple-small flex flex-wrap items-center gap-3" role="status">
          <span className="flex-1">Oracle is still drafting the new item.</span>
          <button type="button" className="simple-button" onClick={refreshDrafting}>
            Refresh
          </button>
        </p>
      )}
      {!reads && alsoWaiting.length > 0 && (
        <HomeCard id="also-waiting" icon="flag" title="Also waiting for you" count={alsoWaiting.length} all="/simple/decisions" allLabel="All that waits on you">
          <ul data-testid="home-also-waiting-list">
            {alsoWaiting.map((i) => (
              <WaitingRow key={i.key} item={i} />
            ))}
          </ul>
        </HomeCard>
      )}

      {!reads && myTasks.length > 0 && (
        <HomeCard id="tasks" icon="check" title="Tasks waiting for you" count={myTasks.length} all="/simple/roadmap" allLabel="Open the roadmap">
          <WithFeatureMarks>
          <ul className="space-y-2" data-testid="home-task-list">
            {myTasks.map((t) => (
              <li key={t.id} data-testid="home-task" className="simple-small [overflow-wrap:anywhere]">
                <Link href={`/simple/roadmap?roadmap=${t.roadmap_id}`} className="simple-link">
                  {t.title}
                </Link>{" "}
                · {t.item_title} <MarkForItem itemId={t.item_id} />
                {t.due_date ? ` · due ${calendarDay(t.due_date)}` : ""}
                {t.late ? " · late" : ""}
              </li>
            ))}
          </ul>
          </WithFeatureMarks>
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
                      {/* home-waiting-one-list: a meeting in another year says its year on the tile too. */}
                      {!sameYear(next.due_at) && <span className="text-[11px] leading-3">{formatInZone(next.due_at, zone, { year: "numeric" })}</span>}
                    </span>
                  }
                  title={next.ritual_title}
                  meta={
                    <>
                      <span className="tnum">
                        {/* home-waiting-one-list: a meeting in another year says its day with the year ("Fri, Jan 8, 2027, 2:00 PM PST"). */}
                        {formatInZone(next.due_at, zone, {
                          weekday: "short",
                          ...(sameYear(next.due_at) ? {} : { month: "short", day: "numeric", year: "numeric" }),
                          hour: "numeric",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })}{" "}
                        · {next.length_min} min
                      </span>
                      <br />
                      {next.attendees.length} {next.attendees.length === 1 ? "attendee" : "attendees"}
                      {next.attendees.length > 0 &&
                        `: ${next.attendees
                          .slice(0, 4)
                          .map((a) => a.name)
                          .join(", ")}`}
                      {/* home-honest-loading: a review of roadmaps that are all in Trash says so. */}
                      {next.reviews_in_trash === "roadmap" && (
                        <>
                          <br />
                          <span data-testid="home-meeting-trash">
                            Reviews a roadmap in Trash ·{" "}
                            <Link className="underline" href={`/company/rituals?ritual=${next.ritual_id}`}>
                              Ritual settings
                            </Link>
                          </span>
                        </>
                      )}
                      {/* home-deleted-roadmap: and once its roadmaps were deleted for good, says that. */}
                      {next.reviews_deleted === "roadmap" && (
                        <>
                          <br />
                          <span data-testid="home-meeting-deleted">
                            Its roadmap was deleted
                            {next.reviews_deleted_at && ` for good on ${formatInZone(next.reviews_deleted_at, zone, { month: "short", day: "numeric" })}`} ·{" "}
                            <Link className="underline" href={`/company/rituals?ritual=${next.ritual_id}`}>
                              Ritual settings
                            </Link>
                          </span>
                        </>
                      )}
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
              {/* In the plan's card, filled with it: above the goal band it pushed everything down.
                  qa4-simple-home-16: the count holds unsent working drafts too, so it never says "in review". */}
              {r.changes_in_review > 0 && (
                <p role="status" data-testid="home-in-review" className="rounded-xl bg-warn-bg px-4 py-3 text-warn">
                  {r.changes_in_review === 1
                    ? "1 change is not approved yet. You see the published plan until it is."
                    : `${r.changes_in_review} changes are not approved yet. You see the published plan until they are.`}
                </p>
              )}
              {plan ? (
                <PlanByMonth plan={plan} testId="home-strip" named />
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
                  {/* qa4-simple-home-21: a reader is told who fixes these and that they cannot. */}
                  {reads && (
                    <p data-testid="home-broken-readers" className="simple-small">
                      {(brokenDeciders.length ? joinAnd(brokenDeciders) : "The owners").replace(/^./, (x) => x.toUpperCase())} {brokenDeciders.length === 1 ? "fixes" : "fix"} these; you can&apos;t change the roadmap.
                    </p>
                  )}
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
                        title={
                          <>
                            <button type="button" className="text-left text-crit hover:underline" onClick={() => setOpened(links[0].item)}>
                              <Named item={links[0].item} />
                            </button>
                            {/* qa4-simple-home-7: the plan draws one PRD; with links on several roadmaps each item says its own. */}
                            {brokenRoadmaps.length > 1 && (
                              <span data-testid="home-broken-roadmap" className="font-normal text-text2">
                                {" "}
                                · {links[0].item.roadmap.title}
                              </span>
                            )}
                          </>
                        }
                        meta={
                          // pre-demo QA S-14: an item's breaks sit under its name, ruled together, never as entries of their own.
                          <ul data-testid="home-broken-breaks" className={`flex flex-col gap-3 ${links.length > 1 ? "border-l-2 border-crit/40 pl-3" : ""}`}>
                            {links.map((b) => (
                              <BrokenRow
                                key={`${b.item.id}-${b.flag.kind}-${b.flag.subject}`}
                                b={b}
                                reads={reads}
                                onFix={fix}
                                moves={b.flag.fixes.includes("shift_dependents") ? shiftMoves(b, roadmap.data?.items ?? []) : []}
                                proposed={mine.find((c) => FIX_OPS.has(c.op) && c.target.item_id === b.item.id && (c.target.subject ?? null) === (b.flag.subject ?? null))}
                                movedWith={movedWith(b)?.item.title}
                                coveredBy={(() => {
                                  const c = coveredBy(b);
                                  return c ? { title: itemTitle(c.target.item_id), waitingFor: c.routed_to.map((id) => nameOf(id, "the decider")).join(", ") || "the decider" } : undefined;
                                })()}
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
                          <button type="button" className="text-left hover:underline" onClick={() => setOpened(i)}>
                            <Named item={i} />
                          </button>
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
      </DecisionSheetHost>
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
      // F-30: how setup works sits in the title's (i), not on the card.
      info={
        <InfoTip label="setting up Oracle" align="start">
          {owner
            ? "A few steps make Oracle yours: connect your tools, pick the sources it reads, then build the Ground Truth it plans from. Each step opens where it is done."
            : "Two steps make Oracle yours: connect your tools and pick the sources it reads for you. Each step opens where it is done."}
        </InfoTip>
      }
      extra={
        <span data-testid="home-setup-count" className="flex items-center gap-3 max-[600px]:basis-full max-[600px]:pl-12">
          {count}
        </span>
      }
    >
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
                // F-27: a finished step opens too, to change it, as Detailed Home's Change does.
                href ? (
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

/** Home's menu (the more icon): Show Set up while it is hidden. Escape or a click outside closes it. */
function HomeMenu({ onShowSetup }: { onShowSetup: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div ref={root} className="relative flex-none">
      <button
        type="button"
        aria-label="Home menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid h-8 w-8 place-items-center rounded-lg text-text2 hover:bg-surface2 max-[600px]:h-11 max-[600px]:w-11"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1 w-44 rounded-lg border border-line bg-surface p-1 shadow-tip">
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-md px-2 py-1.5 text-left text-[15px] hover:bg-surface2 max-[600px]:min-h-11"
            onClick={() => {
              setOpen(false);
              onShowSetup();
            }}
          >
            Show Set up
          </button>
        </div>
      )}
    </div>
  );
}

/** build-rundecide RD3 a: the questions I own, one group per PRD, the PRD with the soonest due first; each soonest first. */
function waitingByPrd(questions: Question[]): { prd: Question["prd"]; questions: Question[] }[] {
  const by = new Map<string, { prd: Question["prd"]; questions: Question[] }>();
  for (const q of questions) {
    const g = by.get(q.prd.slug) ?? { prd: q.prd, questions: [] };
    g.questions.push(q);
    by.set(q.prd.slug, g);
  }
  const due = (q: Question) => q.due_on ?? "9999";
  const groups = [...by.values()].map((g) => ({ ...g, questions: [...g.questions].sort((a, b) => due(a).localeCompare(due(b)) || a.number - b.number) }));
  return groups.sort((a, b) => due(a.questions[0]!).localeCompare(due(b.questions[0]!)));
}

/** Home's decision rows: the late questions first, then the other judgement calls, then the rest of the questions (soonest first). */
function homeDecisionRows(questions: Question[], others: Decision[]): (Question | Decision)[] {
  return [...questions.filter((q) => q.late), ...others, ...questions.filter((q) => !q.late)];
}

/** A decision waiting for me: Decide with the proposed option, or choose another. */
function DecisionRow({ d, onDecide }: { d: Decision; onDecide: (d: Decision, key: string) => void }) {
  const [other, setOther] = useState(false);
  // ec1 b: its title opens the decision sheet (every field, Edit, Withdraw, Delete), as on Decisions.
  const sheet = useDecisionSheet();
  const proposed = d.options.find((o) => o.recommended) ?? d.options[0];
  return (
    <HomeRow
      testId="home-decision"
      inlineActions
      lead={<RowIcon name="flag" />}
      title={
        sheet ? (
          <button type="button" data-testid="home-decision-open" title={d.ref ? `${d.ref} · ${d.title}` : undefined} className="text-left font-[650] underline decoration-1 underline-offset-4 hover:text-accent-ink" onClick={() => sheet.open({ kind: "decision-id", id: d.id, title: `${d.ref} ${d.title}` })}>
            {d.title}
          </button>
        ) : (
          <span title={d.ref ? `${d.ref} · ${d.title}` : undefined}>{d.title}</span>
        )
      }
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
  movedWith,
  coveredBy,
  nameOf,
}: {
  b: BrokenLink;
  reads: boolean;
  onFix: (b: BrokenLink, op: FixOp, note?: string) => Promise<void>;
  /** The items "Move the dependents" moves, the item first. */
  moves: Schemas["SimpleRoadmapItem"][];
  /** My proposal waiting on this link (GET /v1/simple/changes: proposed, by me, its item and subject). */
  proposed?: Change;
  /** qa4-simple-home-5: the item above whose "Move the dependents" moves this one too (its control is there). */
  movedWith?: string;
  /** qa4-simple-home-18: my waiting proposal on another item that moves this one too. */
  coveredBy?: { title: string; waitingFor: string };
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
  // One "Move the dependents" per move (qa4-simple-home-5), none once my proposal elsewhere makes it (qa4-simple-home-18).
  const shifts = b.flag.fixes.includes("shift_dependents") && !movedWith && !coveredBy;
  return (
    <li data-testid="home-broken" className="flex flex-col gap-2">
      <span className="text-text">
        <span className="sr-only">{b.item.title}: </span>
        {problemWords(b.flag.reason, b.item.title)}
      </span>
      {proposed && (
        <span data-testid="home-broken-proposed" className="block font-semibold text-text">
          You proposed: {FIX_WORDS[proposed.op as FixOp] ?? opWords(proposed.op)} · waiting for {waitingFor}
        </span>
      )}
      {showFixes && coveredBy && (
        <span data-testid="home-broken-covered" className="simple-small">
          Your proposal to move the dependents of {coveredBy.title} moves this one too · waiting for {coveredBy.waitingFor}
        </span>
      )}
      {showFixes && !coveredBy && movedWith && (
        <span data-testid="home-broken-moved-with" className="simple-small">
          {applies ? FIX_WORDS.shift_dependents : `Propose: ${FIX_WORDS.shift_dependents.toLowerCase()}`} on {movedWith} above moves this one too.
        </span>
      )}
      {showFixes && shifts && b.dependency && moves.length > 0 && (
        <span id={moveId} data-testid="home-broken-moves" className="simple-small">
          Moving the dependents starts {joinAnd(moves.map((m) => m.title))} after {b.dependency.title} ends.
        </span>
      )}
      {showFixes && (
        <span data-testid="home-row-actions" className="flex flex-wrap items-center gap-2">
          {shifts && (
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
