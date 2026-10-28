"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Chip, InfoTip, KpiStrip, Notice, Page, PageHeader, Split, ViewOnly, type Kpi } from "@/components/ds";
import { VagueGoalsLine } from "@/components/discuss/VagueGoalsLine";
import { Loading } from "@/components/ui";
import { startInterview, startInterviews, vagueGoals } from "@/lib/api/goal-interview";
import { GOALS_OBSERVE, useGoalsLevel } from "@/lib/goals-autonomy";
import { api, unwrap, type ConflictOut, type EntityOut, type ProposalOut } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { AddItemSheet, type AddKind } from "./_components/AddItem";
import { BlockerInspector } from "./_components/BlockerInspector";
import { BlockersTab } from "./_components/BlockersTab";
import { BuildBanner, BuildBaselineSheet, BuildChip, currentBuild } from "./_components/BuildBaseline";
import { goalTags, KPI_PHONE } from "./_components/common";
import { ConflictsTab } from "./_components/ConflictsTab";
import { EntityDrawer } from "./_components/EntityDrawer";
import { FlaggedTab } from "./_components/FlaggedTab";
import { FromRunBand, FromRunTab, RowActions, WhyCard } from "./_components/FromRunTab";
import { fillNotice } from "./_components/goal-fields";
import type { Stepper } from "./_components/GoalInterview";
import { GraphTab } from "./_components/GraphTab";
import { ItemsTab } from "./_components/ItemsTab";
import { fieldName, noChange, ProposalsTab, type FromFilter } from "./_components/ProposalsTab";
import { Tabs, type TabItem } from "./_components/Tabs";

type Tab = "from-run" | "graph" | "items" | "flagged" | "conflicts" | "proposals" | "blockers";
const TABS: readonly Tab[] = ["from-run", "graph", "items", "flagged", "conflicts", "proposals", "blockers"];

/**
 * ?tab=<tab> opens that tab; ?run=<run id or none> filters the proposals (a run page's Review
 * links here) and, without a tab, opens From this run (B2: the Inbox's and the run page's Review).
 */
function TabFromUrl({ onTab, onFrom, onRun }: { onTab: (tab: Tab) => void; onFrom: (from: FromFilter) => void; onRun: (run: string) => void }) {
  const params = useSearchParams();
  const tab = params.get("tab");
  const run = params.get("run") ?? "";
  useEffect(() => {
    if (tab && (TABS as readonly string[]).includes(tab)) onTab(tab as Tab);
    else if (!tab && run && run !== "none") onTab("from-run");
  }, [tab, run, onTab]);
  useEffect(() => onFrom(run), [run, onFrom]);
  useEffect(() => onRun(run && run !== "none" ? run : ""), [run, onRun]);
  return null;
}

/** ?build=1 opens the Build the baseline sheet (Home, Set up and the New run dialog link here). */
function BuildFromUrl({ onBuild }: { onBuild: () => void }) {
  const build = useSearchParams().get("build") === "1";
  useEffect(() => {
    if (build) onBuild();
  }, [build, onBuild]);
  return null;
}

/** ?entity=<id> opens that item (Publish's Resolve links here); ?blocker=<id> that blocker (its Open blocker). */
function OpenFromUrl({ onOpen, onBlocker }: { onOpen: (id: string) => void; onBlocker: (id: string) => void }) {
  const params = useSearchParams();
  const id = params.get("entity");
  const blocker = params.get("blocker");
  useEffect(() => {
    if (id) onOpen(id);
  }, [id, onOpen]);
  useEffect(() => {
    if (blocker) onBlocker(blocker);
  }, [blocker, onBlocker]);
  return null;
}

/**
 * B6: ?interview=1 with ?entity=<goal> starts (or reopens) that goal's interview (Home's Make
 * measurable); ?interview=vague steps through the vague goals (a run page's Interview).
 */
function InterviewFromUrl({ onGoal, onVague }: { onGoal: (id: string) => void; onVague: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const interview = params.get("interview");
  const entity = params.get("entity");
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!interview) return;
    const key = `${interview}:${entity ?? ""}`;
    if (done.current === key) return;
    done.current = key;
    if (interview === "vague") onVague();
    else if (entity) onGoal(entity);
    // Once: a reload does not start another.
    const next = new URLSearchParams(params.toString());
    next.delete("interview");
    const rest = next.toString();
    router.replace(rest ? `/baseline?${rest}` : "/baseline", { scroll: false });
  }, [interview, entity, onGoal, onVague, params, router]);
  return null;
}

export default function BaselinePage() {
  const { me, can, capsReady, capsError } = useMe();
  // #370: approvers change the baseline, commenters propose; a viewer only reads it.
  const canWrite = can("confirm_entity");
  const canComment = can("create_proposal");
  // B6: a goals interview is a commenter's to start, like a proposal; H11: not while Shape goals
  // is at Observe (the sentence stands where Make measurable would), and not before its level loads.
  const goalsLevel = useGoalsLevel();
  const canInterview = can("start_goal_interview") && goalsLevel !== undefined && goalsLevel !== "observe";
  const goalsNote = can("start_goal_interview") && goalsLevel === "observe" ? GOALS_OBSERVE : null;
  const onAuth = useAuthRedirect();

  const graph = useQuery("baseline-graph", () => unwrap(api.GET("/v1/baseline/graph")));
  const trace = useQuery("baseline-trace", () => unwrap(api.GET("/v1/baseline/trace")));
  const conflicts = useQuery("baseline-conflicts", () => unwrap(api.GET("/v1/baseline/conflicts")));
  const blockers = useQuery("baseline-blockers", () => unwrap(api.GET("/v1/blockers")));
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("graph");
  const [from, setFrom] = useState<FromFilter>("");
  // B2: the run whose review this is (?run=), and what it wrote to the baseline.
  const [runId, setRunId] = useState("");
  const fromRun = useQuery(
    `baseline-from-run:${runId}`,
    () => (runId ? unwrap(api.GET("/v1/baseline/from-run/{run_id}", { params: { path: { run_id: runId } } })) : Promise.resolve(null)),
    { keepPrevious: true },
  );
  // Every open proposal (the tab's count and the From select's runs), and the From filter's.
  const proposals = useQuery("baseline-proposals", () =>
    unwrap(api.GET("/v1/baseline/proposals", { params: { query: { status: "open" } } })),
  );
  const filtered = useQuery(
    `baseline-proposals-from:${from}`,
    () =>
      from
        ? unwrap(api.GET("/v1/baseline/proposals", { params: { query: { status: "open", run_id: from } } }))
        : Promise.resolve(null),
    { keepPrevious: true },
  );
  const chooseFrom = (next: FromFilter) => {
    setFrom(next);
    router.replace(next ? `/baseline?tab=proposals&run=${encodeURIComponent(next)}` : "/baseline?tab=proposals", { scroll: false });
  };
  const shown = from ? (filtered.data ?? undefined) : proposals.data;

  const [openId, setOpenId] = useState<string | null>(null);
  // The blocker inspector (#340) takes the drawer's place while a blocker is open.
  const [blockerId, setBlockerId] = useState<string | null>(null);
  // A suggested blocker opened from its Promote button opens on the blocker form (B4).
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // B1: the latest Build the baseline run (the banner and the header's chip), and the sheet.
  const runs = useQuery("baseline-builds", () => unwrap(api.GET("/v1/runs")));
  const build = currentBuild(runs.data);
  const [building, setBuilding] = useState(false);
  const openBuild = useCallback(() => setBuilding(true), []);
  const closeBuild = () => {
    setBuilding(false);
    router.replace("/baseline", { scroll: false });
  };
  const started = () => {
    closeBuild();
    setNotice("Building the baseline. You'll get an Inbox item when it's ready to review.");
    void runs.reload();
  };

  const { reload: reloadGraph } = graph;
  const { reload: reloadTrace } = trace;
  const { reload: reloadConflicts } = conflicts;
  const { reload: reloadProposals } = proposals;
  const { reload: reloadFiltered } = filtered;
  const { reload: reloadBlockers } = blockers;
  // B6: the vague goals (the Goals panel's Interview vague goals), read only, nothing started.
  const vague = useQuery("baseline-vague", vagueGoals);
  const { reload: reloadVague } = vague;
  const { reload: reloadFromRun } = fromRun;
  const refresh = useCallback(() => {
    void Promise.all([reloadGraph(), reloadTrace(), reloadConflicts(), reloadProposals(), reloadFiltered(), reloadBlockers(), reloadVague(), reloadFromRun()]);
  }, [reloadGraph, reloadTrace, reloadConflicts, reloadProposals, reloadFiltered, reloadBlockers, reloadVague, reloadFromRun]);
  // B6: the goal whose interview the drawer's Discuss view shows, and the stepper over the vague goals.
  const [discuss, setDiscuss] = useState<{ entityId: string; discussionId: string } | null>(null);
  const [steps, setSteps] = useState<{ ids: string[]; at: number } | null>(null);
  const [starting, setStarting] = useState(false);
  // #337: Add item, on the kind the button that opened it names.
  const [adding, setAdding] = useState<AddKind | null>(null);
  const added = (message: string) => {
    setAdding(null);
    setError(null);
    setNotice(message);
    refresh();
  };
  const close = useCallback(() => {
    setOpenId(null);
    setPromoteId(null);
    setDiscuss(null);
    setSteps(null);
  }, []);
  const openItem = useCallback((id: string) => {
    setBlockerId(null);
    setOpenId(id);
    setDiscuss((x) => (x && x.entityId !== id ? null : x));
  }, []);
  const interview = useCallback(
    async (start: () => Promise<{ entityId: string; discussionId: string }>) => {
      setStarting(true);
      setError(null);
      try {
        const next = await start();
        setBlockerId(null);
        setPromoteId(null);
        setOpenId(next.entityId);
        setDiscuss(next);
        void reloadVague();
      } catch (e) {
        if (!onAuth(e)) setError(errorMessage(e));
      } finally {
        setStarting(false);
      }
    },
    [onAuth, reloadVague],
  );
  /** Make measurable: the goal's open interview, or a new one. */
  const makeMeasurable = useCallback(
    (id: string) => {
      setSteps(null);
      void interview(async () => ({ entityId: id, discussionId: (await startInterview(id)).discussion_id }));
    },
    [interview],
  );
  /** The stepper reaches goal `at`: only now is its discussion created. */
  const reach = useCallback(
    (ids: string[], at: number) => {
      setSteps({ ids, at });
      void interview(async () => {
        const [row] = await startInterviews([ids[at]]);
        return { entityId: ids[at], discussionId: row.discussion_id };
      });
    },
    [interview],
  );
  const interviewVague = useCallback(async () => {
    try {
      const ids = (await vagueGoals()).map((v) => v.entity.id);
      if (ids.length === 0) return setNotice("Every goal is measurable.");
      reach(ids, 0);
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
    }
  }, [reach, onAuth]);
  const stepper: Stepper | null = steps
    ? {
        at: steps.at,
        of: steps.ids.length,
        busy: starting,
        next: steps.at + 1 < steps.ids.length ? () => reach(steps.ids, steps.at + 1) : undefined,
        // Skip passes over the next goal: its discussion is never created.
        skip: steps.at + 1 < steps.ids.length ? () => (steps.at + 2 < steps.ids.length ? reach(steps.ids, steps.at + 2) : setSteps(null)) : undefined,
        done: () => setSteps(null),
      }
    : null;
  // B6: the run the From filter names, for its after-review line.
  const filterRun = useQuery(`baseline-filter-run:${from}`, () =>
    from && from !== "none" ? unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: from } } })) : Promise.resolve(null),
  );
  const reviewed = filterRun.data?.checkpoints.find((c) => c.kind === "baseline_confirm" && c.status === "approved") as
    | { vague_goals?: number | null }
    | undefined;
  const openBlocker = useCallback((id: string) => {
    setOpenId(null);
    setPromoteId(null);
    setTab("blockers");
    setBlockerId(id);
  }, []);
  const closeBlocker = useCallback(() => setBlockerId(null), []);
  const promote = useCallback((id: string) => {
    setPromoteId(id);
    setBlockerId(null);
    setOpenId(id);
  }, []);

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      refresh();
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const confirmGoal = (goal: EntityOut) =>
    act(async () => {
      await unwrap(api.POST("/v1/baseline/entities/{entity_id}/confirm", { params: { path: { entity_id: goal.id } } }));
      return `Confirmed “${goal.title}”.`;
    });

  /** #345: a new subgoal under `parent`, proposed like any goal; its target is set in its drawer. */
  async function addSubgoal(parent: EntityOut, title: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "subgoal";
      const taken = new Set((graph.data?.entities ?? []).filter((e) => e.type === "goal").map((e) => e.key));
      let key = `${parent.key}.${slug}`.slice(0, 120);
      for (let n = 2; taken.has(key); n++) key = `${parent.key}.${slug}-${n}`.slice(0, 120);
      await unwrap(
        api.POST("/v1/baseline/entities", {
          body: { type: "goal", key, title, attrs: {}, parent_id: parent.id, origin: "user" },
        }),
      );
      setNotice(`Added “${title}” under “${parent.title}”.`);
      refresh();
      return true;
    } catch (e) {
      if (!onAuth(e)) setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const fillFromText = () =>
    act(async () => fillNotice(await unwrap(api.POST("/v1/baseline/goals/fill-from-text"))));

  const pick = (conflict: ConflictOut, claim: number) =>
    act(async () => {
      await unwrap(
        api.POST("/v1/baseline/conflicts/{conflict_id}/resolve", {
          params: { path: { conflict_id: conflict.id } },
          body: { claim },
        }),
      );
      return "Conflict resolved.";
    });

  const decide = (proposal: ProposalOut, accept: boolean, skip: string[] = []) =>
    act(async () => {
      const params = { params: { path: { proposal_id: proposal.id } } };
      if (accept) await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/accept", { ...params, body: { skip_fields: skip } }));
      else await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/reject", params));
      if (accept && skip.length > 0)
        return `Proposal accepted without ${skip.map(fieldName).join(", ")}: the rest is applied and the item is locked against Oracle's changes until a person unlocks it.`;
      if (accept) return "Proposal accepted: the change is applied and the item is locked against Oracle's changes until a person unlocks it.";
      return noChange(proposal) ? "Proposal dismissed: it changed nothing." : "Proposal rejected.";
    });

  const openConflicts = conflicts.data?.filter((c) => c.status === "open").length;
  const view = runId ? fromRun.data : null;
  const tabs: TabItem<Tab>[] = [
    ...(view ? [{ id: "from-run" as const, label: "From this run", count: view.summary.need_you, kind: "crit" as const }] : []),
    { id: "graph", label: "Graph" },
    { id: "items", label: "Items" },
    { id: "flagged", label: "Flagged", count: trace.data?.summary.flagged, kind: "crit" },
    { id: "conflicts", label: "Conflicts", count: openConflicts, kind: "warn" },
    { id: "proposals", label: "Proposals", count: proposals.data?.length, kind: "acc" },
    { id: "blockers", label: "Blockers", count: blockers.data?.length, kind: "warn" },
  ];
  const openEntity = openId ? graph.data?.entities.find((e) => e.id === openId) : undefined;
  const openRow = openEntity && view ? view.rows.find((r) => r.entity.id === openEntity.id) : undefined;
  const low = trace.data?.low;
  const tags = useMemo(() => goalTags(graph.data), [graph.data]);
  // The From select's runs: each run with open proposals, newest first, and the one chosen.
  const fromRuns = useMemo(() => {
    const seen = new Map<string, NonNullable<ProposalOut["run"]>>();
    for (const p of [...(proposals.data ?? []), ...(filtered.data ?? [])]) if (p.run) seen.set(p.run.id, p.run);
    return [...seen.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [proposals.data, filtered.data]);

  // The count strip: only what the graph and the trace report say.
  const s = trace.data?.summary;
  const traced = trace.data?.features.filter((f) => f.goals.length > 0).length;
  const evidence = graph.data
    ? [...graph.data.entities, ...graph.data.edges]
        .filter((e) => e.status !== "rejected")
        .reduce((n, e) => n + (e.evidence_count ?? 0), 0)
    : undefined;
  const kpis: Kpi[] = [
    { label: "Goals confirmed", value: s?.confirmed_goals ?? "–", of: s?.goals, testId: "kpi-goals" },
    { label: "Features traced", value: traced ?? "–", of: s?.features, testId: "kpi-traced" },
    { label: "Evidence items", value: evidence ?? "–", testId: "kpi-evidence" },
    {
      label: "Weak evidence",
      value: s?.weak_evidence ?? "–",
      tone: s && s.weak_evidence > 0 ? "warn" : undefined,
      testId: "kpi-weak",
      extra: (
        <InfoTip label="Weak evidence">Features whose evidence all scores under the low-confidence threshold.</InfoTip>
      ),
    },
  ];

  // The page waits for what the role may do: drawn before it, Add item, Promote to blocker, the
  // Accept help line and the Accept buttons appear afterwards and push what a person reads down
  // (on a phone, out of view). A failed read shows the viewer's page.
  if (!capsReady && !capsError)
    return (
      <Page>
        <PageHeader title="Baseline" />
        <Loading />
      </Page>
    );

  return (
    <Page>
      <Suspense fallback={null}>
        <OpenFromUrl onOpen={openItem} onBlocker={openBlocker} />
        <TabFromUrl onTab={setTab} onFrom={setFrom} onRun={setRunId} />
        {canInterview && <InterviewFromUrl onGoal={makeMeasurable} onVague={() => void interviewVague()} />}
        {canWrite && <BuildFromUrl onBuild={openBuild} />}
      </Suspense>
      {building && canWrite && <BuildBaselineSheet onClose={closeBuild} onStarted={started} />}
      {adding && canWrite && (
        <AddItemSheet kind={adding} graph={graph.data} tags={tags} onClose={() => setAdding(null)} onAdded={added} />
      )}
      <PageHeader
        title="Baseline"
        info={
          <InfoTip label="Baseline" align="start" side="bottom">
            Goals, products and features the product is built on, each linked to its evidence.
          </InfoTip>
        }
        action={
          <span className="flex flex-wrap items-center gap-2">
            {/* The Items tab has its own Add, on the kind it shows: one Add control there (qa-plan-49). */}
            {canWrite && tab !== "items" && (
              <Button icon="plus" className="h-10" onClick={() => setAdding("goal")}>
                Add item
              </Button>
            )}
            {canWrite &&
              runs.data &&
              (build && build.status !== "failed" ? (
                <BuildChip build={build} />
              ) : (
                <Button variant="primary" icon="baseline" onClick={openBuild}>
                  Build baseline
                </Button>
              ))}
          </span>
        }
        status={
          <>
            {/* On a phone the Counts strip right below says it ("Goals confirmed"): the chip
                would stand on a line by itself above the actions (qa-plan-50). */}
            {s && (
              <span className="inline-flex max-[600px]:hidden">
                <Chip kind="pass" data-testid="confirmed-chip">
                  {s.confirmed_goals} confirmed
                </Chip>
              </span>
            )}
            {capsReady && !canComment && <ViewOnly />}
          </>
        }
      />

      <Split
        inspector={
          blockerId ? (
            <BlockerInspector key={blockerId} blockerId={blockerId} onClose={closeBlocker} onChanged={refresh} />
          ) : (
            openEntity && (
            <EntityDrawer
              key={openEntity.id}
              entity={openEntity}
              graph={graph.data}
              low={low}
              canWrite={canWrite}
              canComment={canComment}
              meId={me?.user_id}
              tags={tags}
              onClose={close}
              onOpen={openItem}
              onChanged={refresh}
              promote={promoteId === openEntity.id}
              onOpenBlocker={blockers.data?.some((b) => b.id === openEntity.id) ? () => openBlocker(openEntity.id) : undefined}
              discussionId={discuss?.entityId === openEntity.id ? discuss.discussionId : null}
              stepper={discuss?.entityId === openEntity.id ? stepper : null}
              onMakeMeasurable={canInterview ? () => makeMeasurable(openEntity.id) : undefined}
              goalsNote={goalsNote}
              onCloseDiscuss={() => {
                setDiscuss(null);
                setSteps(null);
              }}
              why={
                openRow &&
                view && (
                  <WhyCard
                    row={openRow}
                    fixes={<RowActions view={view} row={openRow} entities={graph.data?.entities ?? []} busy={busy} act={act} onOpen={openItem} inDrawer />}
                  />
                )
              }
            />
            )
          )
        }
      >
        <div className={KPI_PHONE}>
          <KpiStrip label="Counts" items={kpis} />
        </div>

        {build && <BuildBanner build={build} />}
        {view && <FromRunBand view={view} />}
        {runId && fromRun.error && <Notice tone="error">{fromRun.error}</Notice>}

        <Tabs label="Baseline views" items={tabs} value={tab} onChange={setTab} />

        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex min-w-0 flex-col gap-4">
          {tab === "from-run" && view && (
            <FromRunTab view={view} entities={graph.data?.entities ?? []} busy={busy} selectedId={openId} act={act} onOpen={openItem} />
          )}
          {tab === "graph" && (
            <>
              {graph.error && <Notice tone="error">{graph.error}</Notice>}
              {graph.loading && !graph.data && <Loading />}
              {graph.data && (
                <GraphTab
                  graph={graph.data}
                  trace={trace.data}
                  canWrite={canWrite}
                  meId={me?.user_id}
                  busy={busy}
                  selectedId={openId}
                  tags={tags}
                  onOpen={openItem}
                  onConfirm={confirmGoal}
                  onFill={fillFromText}
                  onMakeMeasurable={canInterview ? (g) => makeMeasurable(g.id) : undefined}
                  vague={vague.data?.length ?? 0}
                  onInterviewVague={canInterview ? () => void interviewVague() : undefined}
                  goalsNote={goalsNote}
                  onAdd={setAdding}
                  onAddSubgoal={canWrite ? addSubgoal : undefined}
                />
              )}
            </>
          )}
          {tab === "items" && (
            <>
              {graph.error && <Notice tone="error">{graph.error}</Notice>}
              {graph.loading && !graph.data && <Loading />}
              {graph.data && (
                <ItemsTab
                  graph={graph.data}
                  canWrite={canWrite}
                  meId={me?.user_id}
                  selectedId={openId}
                  onOpen={openItem}
                  onAdd={setAdding}
                />
              )}
            </>
          )}
          {tab === "flagged" && (
            <>
              {trace.error && <Notice tone="error">{trace.error}</Notice>}
              {trace.loading && !trace.data && <Loading />}
              {trace.data && <FlaggedTab trace={trace.data} tags={tags} selectedId={openId} onOpen={openItem} />}
            </>
          )}
          {tab === "conflicts" && (
            <>
              {conflicts.error && <Notice tone="error">{conflicts.error}</Notice>}
              {conflicts.loading && !conflicts.data && <Loading />}
              {conflicts.data && (
                <ConflictsTab
                  conflicts={conflicts.data}
                  graph={graph.data}
                  low={low}
                  canWrite={canWrite}
                  busy={busy}
                  onOpen={openItem}
                  onPick={pick}
                />
              )}
            </>
          )}
          {tab === "blockers" && (
            <>
              {blockers.error && <Notice tone="error">{blockers.error}</Notice>}
              {blockers.loading && !blockers.data && <Loading />}
              {blockers.data && <BlockersTab blockers={blockers.data} selectedId={blockerId} onOpen={openBlocker} />}
            </>
          )}
          {tab === "proposals" && (
            <>
              {(from ? filtered : proposals).error && <Notice tone="error">{(from ? filtered : proposals).error}</Notice>}
              {!shown && <Loading />}
              {shown && (
                <ProposalsTab
                  proposals={shown}
                  runs={fromRuns}
                  from={from}
                  onFrom={chooseFrom}
                  graph={graph.data}
                  meId={me?.user_id}
                  canWrite={canWrite}
                  busy={busy}
                  onOpen={openItem}
                  onDecide={decide}
                  onPromote={promote}
                  afterReview={
                    canInterview && reviewed?.vague_goals ? (
                      <VagueGoalsLine count={reviewed.vague_goals} busy={starting} onInterview={() => void interviewVague()} />
                    ) : undefined
                  }
                  onMakeMeasurable={canInterview ? makeMeasurable : undefined}
                />
              )}
            </>
          )}
        </div>
      </Split>
    </Page>
  );
}
