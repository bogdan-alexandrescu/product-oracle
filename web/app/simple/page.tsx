"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { setupOpen } from "@/app/home/_setup";
import { Avatar, Block, GoalBandSkeleton, HomeCard, HomeRow, RowIcon, SkeletonRows, Top } from "@/app/simple/_home/cards";
import { Walk } from "@/app/simple/_home/walk";
import { Icon } from "@/components/ds/Icon";
import { toast } from "@/components/ds/Toast";
import { GoalPanel, SuggestionsButton, useGoalSuggestions, type GoalBrief } from "@/components/simple/GoalSuggestions";
import { usePhone } from "@/components/simple/FlowViews";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { QuestionRow, useQuestionActions, type Question } from "@/components/simple/questions/Questions";
import { SimplePage } from "@/components/simple/SimplePage";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
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

/** Where a proposal is reviewed: the roadmap's "Needs a decision" list. */
const REVIEW = "/simple/roadmap?review=1";

/** A broken link's one-click fixes, and what each did, in a toast ("Risk accepted in your working draft"). */
type FixOp = "shift_dependents" | "move_dependency" | "accept_risk";
const FIX_OPS = new Set<string>(["shift_dependents", "move_dependency", "accept_risk"]);
const FIX_DONE: Record<FixOp, string> = {
  shift_dependents: "Dependents moved",
  move_dependency: "Dependency moved",
  accept_risk: "Risk accepted",
};
/** A fix's button words ("Move dependents"). */
const FIX_WORDS: Record<FixOp, string> = {
  shift_dependents: "Move dependents",
  move_dependency: "Move dependency",
  accept_risk: "Accept as risk",
};

/**
 * The Set up checklist's steps in Simple's words, each opening where it is done (the same
 * pages as Detailed Home's checklist, app/home/_setup.tsx). A step this build has no words for
 * keeps its row, under its key's words, with no link.
 */
const SETUP_STEPS: Record<string, { label: string; href: string }> = {
  connect: { label: "Connect your tools", href: "/settings/connections?from=setup" },
  sources: { label: "Pick your sources", href: "/settings/sources?from=setup" },
  invite: { label: "Invite your team", href: "/settings/members?from=setup" },
  domains: { label: "Add the company's email domains", href: "/settings/sources?from=setup#company-domains" },
  eng_lead: { label: "Name the engineering lead", href: "/settings/members?from=setup#engineering-lead" },
  horizons: { label: "Check the planning horizons", href: "/settings/company?from=setup#horizons" },
  timezone: { label: "Set the company time zone", href: "/settings/company?from=setup#timezone" },
  build_baseline: { label: "Build the baseline", href: "/baseline?build=1" },
};
const stepWords = (key: string) => {
  const w = key.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

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
  // A new company (no goals yet) leads with its setup; otherwise it closes Home, so nothing above moves.
  const setupCard = setup ? <SetupCard setup={setup} onHide={() => void hideSetup()} /> : null;
  const setupFirst = !!setup && tiles !== undefined && tiles.length === 0;
  const decidedLately = useQuery(k("decided"), () => unwrap(api.GET("/v1/decisions", { params: { query: { status: "decided" } } })));
  const onePagers = useQuery(k("one-pagers"), () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));

  // S7: Oracle's suggested features under each goal of the band (an accept reloads Home).
  const suggestions = useGoalSuggestions(reloadAll);
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
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
    () => (roadmap.data && planPrd ? planByMonth(roadmap.data.items.filter((i) => i.prd?.id === planPrd.id && i.status !== "cut").flatMap(planInputs), roadmap.data.today) : null),
    [roadmap.data, planPrd],
  );
  const draft = (drafts.data ?? []).find((d) => d.status === "working" && d.changes > 0 && (d.created_by === myId || d.participant_ids.includes(myId)));
  const proposalRows = toDecide.length > 0 || decidesAll ? toDecide : mine;
  const proposalTitle = toDecide.length > 0 || decidesAll ? "Proposals on your items" : "Your proposals waiting";
  // A decider's own proposals on items others decide wait too: their own card.
  const mineApart = proposalRows === toDecide ? mine : [];
  const itemTitle = (id: unknown) => roadmap.data?.items.find((i) => i.id === id)?.title ?? "An item";

  const now = new Date();
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
  const proposable = `${brokenOthers} ${brokenOthers === 1 ? "broken link" : "broken links"} you can propose fixes for.`;
  const sentence = reads
    ? "Here is where the plan stands."
    : brokenOthers === 0
      ? waits
      : brokenMine + decisionCount + (proposalRows === toDecide ? toDecide.length : 0) === 0
        ? proposable
        : `${waits} Also ${proposable}`;
  // The goal band's weights as their share of the score ("50% of the score").
  const weightSum = (tiles ?? []).reduce((n, g) => n + (g.weight != null && g.weight > 0 ? g.weight : 0), 0);
  const share = (w: number | null) => (w != null && w > 0 && weightSum > 0 ? Math.round((w / weightSum) * 100) : null);
  // The broken-links list's heading names the roadmaps they are on.
  const brokenRoadmaps = [...new Set(broken.map((b) => b.item.roadmap.title))];

  const proposalRow = (c: Change) => (
    <HomeRow
      key={c.id}
      testId="home-proposal"
      lead={<Avatar name={c.by_name} />}
      title={`${OP_WORDS[c.op] ?? c.op}: ${itemTitle(c.target.item_id)}${typeof c.after.title === "string" && NEW_FLOW_OPS.has(c.op) ? ` · ${c.after.title}` : ""}`}
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
              onClick={() => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: c.id } } })), "Accepted")}
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
      const message = await changeResult(r, `${FIX_DONE[op]} in your working draft`);
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
      <header data-testid="home-greeting" className="-mt-4 flex flex-col gap-1">
        <p className="simple-small tnum">{formatInZone(now.toISOString(), zone, { weekday: "long", month: "long", day: "numeric" })}</p>
        <p className="simple-lead max-[600px]:min-h-[2lh]">
          {greeting(hour)}
          {firstName ? `, ${firstName}` : ""}. <span data-testid="home-sentence">{sentence}</span>
        </p>
        {!walking && capsReady && !reads && (
          <div>
            <button type="button" className="simple-button simple-button-primary" onClick={() => setWalking(true)}>
              Walk me through it
            </button>
          </div>
        )}
        {/* While the role is unknown the walk's slot keeps its height; a reader known has no walk and no gap. */}
        {!walking && !capsReady && (
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
      {setupFirst && setupCard}

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
                    <div className="flex items-center gap-2">
                      <span className="simple-code">{g.code}</span>
                      {g.guardrail && <span className="simple-tag">guardrail</span>}
                      {share(g.weight) != null && (
                        <span
                          data-testid="home-goal-weight"
                          title="How much this goal counts in each feature's priority score"
                          className="simple-small ml-auto tnum"
                        >
                          {share(g.weight)}% of the score
                        </span>
                      )}
                    </div>
                    <span className="font-semibold">{g.name}</span>
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

      {!reads && (
        <section aria-label="Summary" data-testid="home-summary" className="simple-card">
          <ul className="grid grid-cols-3 gap-3 max-[600px]:gap-2">
            {[
              ["decisions", waiting.data ? decisionCount : null, "decisions waiting for you"],
              ["proposals", changes.data ? proposalRows.length : null, proposalRows === toDecide ? "proposals on your items" : "of your proposals waiting"],
              ["broken-links", roadmap.data ? broken.length : null, "broken links"],
            ].map(([id, n, label]) => (
              <li key={id as string}>
                <a
                  href={`#${id}`}
                  data-testid={`home-summary-${id}`}
                  className="flex h-full flex-col rounded-xl bg-surface2 px-4 py-3 hover:bg-accent-soft max-[600px]:px-2.5 max-[600px]:py-2"
                >
                  <span className="simple-number tnum max-[600px]:text-[22px]! max-[600px]:leading-7!">{n ?? "–"}</span>
                  <span className="simple-small max-[600px]:text-[13px]! max-[600px]:leading-4">{label}</span>
                </a>
              </li>
            ))}
          </ul>
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

      {!reads && (
        <HomeCard
          id="decisions"
          icon="flag"
          title="Decisions waiting for you"
          count={waiting.data?.count}
          all="/simple/decisions"
          allLabel="All decisions"
        >
          <Block q={{ ...decisions, error: waiting.error ?? decisions.error, data: waiting.data && decisions.data ? homeDecisionRows(waiting.data.questions, decisions.data) : undefined }} testId="home-decisions">
            {(rows) =>
              rows.length === 0 ? (
                <p className="simple-small" data-testid="home-decisions-empty">
                  No decision waits on you.
                </p>
              ) : (
                <Top rows={rows} max={phone ? 2 : 3} more="/simple/decisions" what="of the decisions">
                  {(d) =>
                    "code" in d ? (
                      <QuestionRow key={d.id} q={d} mode="list" testId="home-question" actions={questionActions} />
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

      {!reads && (
        <HomeCard id="proposals" icon="comment" title={proposalTitle} count={changes.data ? proposalRows.length : null} all={REVIEW} allLabel="All proposals">
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
        <HomeCard id="my-proposals" icon="comment" title="Your proposals waiting" count={mineApart.length} all={REVIEW} allLabel="All your proposals">
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
                      <Link href={`/simple/meetings?start=${next.ritual_id}`} className="simple-button simple-button-primary">
                        Start meeting
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
              {/* The plan's span, when the PRD's plan dates it ("2 Nov - 12 Feb"). */}
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
                <PlanByMonth plan={plan} prd={planPrd} testId="home-strip" />
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
                  {/* Every broken link the summary counts, never only the first three. */}
                  <Top rows={broken} max={broken.length} more="/simple/roadmap">
                    {(b) => (
                      <BrokenRow
                        key={`${b.item.id}-${b.flag.kind}-${b.flag.subject}`}
                        b={b}
                        reads={reads}
                        onFix={fix}
                        proposed={mine.find((c) => FIX_OPS.has(c.op) && c.target.item_id === b.item.id && (c.target.subject ?? null) === (b.flag.subject ?? null))}
                        nameOf={nameOf}
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
                      title={r.title}
                      meta={`${r.who && r.status ? `${r.who} · ${r.status} · ` : ""}${formatInZone(r.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                    />
                  )}
                </Top>
              );
            }}
          </Block>
        </HomeCard>
      )}
      {!setupFirst && setupCard}
      </>
      )}
    </SimplePage>
  );
}

/** Set up (qa-onboarding-4): Detailed Home's checklist on Simple's Home, a welcome and each step, until all are done. */
function SetupCard({ setup, onHide }: { setup: Schemas["SetupOut"]; onHide: () => void }) {
  return (
    <HomeCard
      id="setup"
      icon="check"
      title="Welcome: set up Oracle"
      extra={
        <>
          <span data-testid="home-setup-progress" className="simple-small tnum whitespace-nowrap">
            {setup.done} of {setup.total} done
          </span>
          <button type="button" className="simple-button simple-button-quiet" onClick={onHide}>
            Hide
          </button>
        </>
      }
    >
      <p className="simple-small">A few steps make Oracle yours: connect your tools, pick the sources it reads, then build the baseline it plans from. Each step opens where it is done.</p>
      <ul className="flex flex-col">
        {setup.steps.map((st) => {
          const copy = SETUP_STEPS[st.key];
          const label = copy?.label ?? stepWords(st.key);
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
                !st.done && copy ? (
                  <Link href={copy.href} className="text-accent-ink hover:underline">
                    {label}
                  </Link>
                ) : (
                  label
                )
              }
              meta={st.done ? "Done" : undefined}
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
      title={d.title}
      meta={
        <>
          {d.ref}
          {d.question ? ` · ${d.question}` : ""}
          {proposed ? ` · Proposed: ${proposed.label}` : ""}
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
 * A broken dependency: the item in red, its one-line reason, and its one-click fixes (proposals
 * for those who propose). Once I proposed a fix it says so, and waits, with no second Propose.
 */
function BrokenRow({
  b,
  reads,
  onFix,
  proposed,
  nameOf,
}: {
  b: BrokenLink;
  reads: boolean;
  onFix: (b: BrokenLink, op: FixOp, note?: string) => Promise<void>;
  /** My proposal waiting on this link (GET /v1/simple/changes: proposed, by me, its item and subject). */
  proposed?: Change;
  nameOf: (id: string, fallback: string) => string;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  // The item says whether I decide it and who does (D-a), as a change's can_decide.
  const applies = b.item.can_decide;
  const deciders = b.item.deciders.length ? b.item.deciders.join(", ") : "The decider";
  const label = (text: string) => (applies ? text : `Propose: ${text}`);
  const hintId = `risk-hint-${b.item.id}-${b.flag.subject ?? b.flag.kind}`;
  const waitingFor = proposed
    ? proposed.routed_to.length
      ? proposed.routed_to.map((id) => nameOf(id, "the decider")).join(", ")
      : b.item.deciders.length
        ? b.item.deciders.join(", ")
        : "the decider"
    : "";
  return (
    <HomeRow
      testId="home-broken"
      inlineActions
      lead={<RowIcon name="alert" />}
      title={<span className="text-crit">{b.item.title}</span>}
      meta={
        <>
          {b.flag.reason}
          {proposed && (
            <span data-testid="home-broken-proposed" className="mt-1 block font-semibold text-text">
              You proposed: {FIX_WORDS[proposed.op as FixOp] ?? OP_WORDS[proposed.op] ?? proposed.op} · waiting for {waitingFor}
            </span>
          )}
          {noting && !proposed && (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
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
                {applies ? "Save risk note" : "Propose risk note"}
              </button>
              <span id={hintId} data-testid="home-risk-hint" className="simple-small basis-full">
                Say why, in one line, to save it.
              </span>
            </form>
          )}
        </>
      }
      actions={
        reads || proposed ? undefined : (
          <>
            {!applies && <span className="simple-small">{`${deciders} ${b.item.deciders.length > 1 ? "decide" : "decides"}`}</span>}
            {b.flag.fixes.includes("shift_dependents") && (
              <button type="button" className="simple-button" onClick={() => void onFix(b, "shift_dependents")}>
                {label("Move dependents")}
              </button>
            )}
            {b.flag.fixes.includes("move_dependency") && (
              <button type="button" className="simple-button" onClick={() => void onFix(b, "move_dependency")}>
                {label("Move dependency")}
              </button>
            )}
            {b.flag.fixes.includes("accept_risk") && (
              <button
                type="button"
                className="simple-button aria-pressed:border-accent! aria-pressed:text-accent-ink!"
                aria-pressed={noting}
                aria-expanded={noting}
                onClick={() => setNoting((n) => !n)}
              >
                {label("Accept as risk")}
              </button>
            )}
          </>
        )
      }
    />
  );
}
