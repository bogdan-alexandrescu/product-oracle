"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { Button, Chip, InfoTip, KpiStrip, Notice, Page, PageHeader, Split, type Kpi } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap, type ConflictOut, type EntityOut, type ProposalOut } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { BuildBanner, BuildBaselineSheet, BuildChip, currentBuild } from "./_components/BuildBaseline";
import { goalTags, KPI_PHONE } from "./_components/common";
import { ConflictsTab } from "./_components/ConflictsTab";
import { EntityDrawer } from "./_components/EntityDrawer";
import { FlaggedTab } from "./_components/FlaggedTab";
import { GraphTab } from "./_components/GraphTab";
import { ProposalsTab, type FromFilter } from "./_components/ProposalsTab";
import { Tabs, type TabItem } from "./_components/Tabs";

type Tab = "graph" | "flagged" | "conflicts" | "proposals";
const TABS: readonly Tab[] = ["graph", "flagged", "conflicts", "proposals"];

/** ?tab=<tab> opens that tab; ?run=<run id or none> filters the proposals (a run page's Review links here). */
function TabFromUrl({ onTab, onFrom }: { onTab: (tab: Tab) => void; onFrom: (from: FromFilter) => void }) {
  const params = useSearchParams();
  const tab = params.get("tab");
  const run = params.get("run") ?? "";
  useEffect(() => {
    if (tab && (TABS as readonly string[]).includes(tab)) onTab(tab as Tab);
  }, [tab, onTab]);
  useEffect(() => onFrom(run), [run, onFrom]);
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

/** ?entity=<id> opens that item (Publish's Resolve links here). */
function OpenFromUrl({ onOpen }: { onOpen: (id: string) => void }) {
  const id = useSearchParams().get("entity");
  useEffect(() => {
    if (id) onOpen(id);
  }, [id, onOpen]);
  return null;
}

export default function BaselinePage() {
  const { me, role } = useMe();
  const canWrite = hasRole(role, "approver");
  const canComment = hasRole(role, "commenter");
  const onAuth = useAuthRedirect();

  const graph = useQuery("baseline-graph", () => unwrap(api.GET("/v1/baseline/graph")));
  const trace = useQuery("baseline-trace", () => unwrap(api.GET("/v1/baseline/trace")));
  const conflicts = useQuery("baseline-conflicts", () => unwrap(api.GET("/v1/baseline/conflicts")));
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("graph");
  const [from, setFrom] = useState<FromFilter>("");
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
  const refresh = useCallback(() => {
    void Promise.all([reloadGraph(), reloadTrace(), reloadConflicts(), reloadProposals(), reloadFiltered()]);
  }, [reloadGraph, reloadTrace, reloadConflicts, reloadProposals, reloadFiltered]);
  const close = useCallback(() => {
    setOpenId(null);
    setPromoteId(null);
  }, []);
  const promote = useCallback((id: string) => {
    setPromoteId(id);
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

  const decide = (proposal: ProposalOut, accept: boolean) =>
    act(async () => {
      const params = { params: { path: { proposal_id: proposal.id } } };
      if (accept) await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/accept", params));
      else await unwrap(api.POST("/v1/baseline/proposals/{proposal_id}/reject", params));
      return accept ? "Proposal accepted: the change is applied and the item locked." : "Proposal rejected.";
    });

  const openConflicts = conflicts.data?.filter((c) => c.status === "open").length;
  const tabs: TabItem<Tab>[] = [
    { id: "graph", label: "Graph" },
    { id: "flagged", label: "Flagged", count: trace.data?.summary.flagged, kind: "crit" },
    { id: "conflicts", label: "Conflicts", count: openConflicts, kind: "warn" },
    { id: "proposals", label: "Proposals", count: proposals.data?.length, kind: "acc" },
  ];
  const openEntity = openId ? graph.data?.entities.find((e) => e.id === openId) : undefined;
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

  return (
    <Page>
      <Suspense fallback={null}>
        <OpenFromUrl onOpen={setOpenId} />
        <TabFromUrl onTab={setTab} onFrom={setFrom} />
        {canWrite && <BuildFromUrl onBuild={openBuild} />}
      </Suspense>
      {building && canWrite && <BuildBaselineSheet onClose={closeBuild} onStarted={started} />}
      <PageHeader
        title="Baseline"
        action={
          canWrite &&
          runs.data &&
          (build && build.status !== "failed" ? (
            <BuildChip build={build} />
          ) : (
            <Button variant="primary" icon="baseline" onClick={openBuild}>
              Build baseline
            </Button>
          ))
        }
        status={
          <>
            {s && (
              <Chip kind="pass" data-testid="confirmed-chip">
                {s.confirmed_goals} confirmed
              </Chip>
            )}
            {!canWrite && role && (
              <>
                <Chip kind="na">Read only</Chip>
                <InfoTip label="Read only" align="start" side="bottom">
                  You can read the baseline; approvers make changes.
                </InfoTip>
              </>
            )}
            <InfoTip label="Baseline" align="start" side="bottom">
              Goals, products and features the product is built on, each linked to its evidence.
            </InfoTip>
          </>
        }
      />

      <Split
        inspector={
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
              onOpen={setOpenId}
              onChanged={refresh}
              promote={promoteId === openEntity.id}
            />
          )
        }
      >
        <div className={KPI_PHONE}>
          <KpiStrip label="Counts" items={kpis} />
        </div>

        {build && <BuildBanner build={build} />}

        <Tabs label="Baseline views" items={tabs} value={tab} onChange={setTab} />

        {error && <Notice tone="error">{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex min-w-0 flex-col gap-4">
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
                  onOpen={setOpenId}
                  onConfirm={confirmGoal}
                />
              )}
            </>
          )}
          {tab === "flagged" && (
            <>
              {trace.error && <Notice tone="error">{trace.error}</Notice>}
              {trace.loading && !trace.data && <Loading />}
              {trace.data && <FlaggedTab trace={trace.data} tags={tags} selectedId={openId} onOpen={setOpenId} />}
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
                  onOpen={setOpenId}
                  onPick={pick}
                />
              )}
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
                  onOpen={setOpenId}
                  onDecide={decide}
                  onPromote={promote}
                />
              )}
            </>
          )}
        </div>
      </Split>
    </Page>
  );
}
