"use client";

import { useCallback, useState } from "react";

import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type ConflictOut, type EntityOut, type ProposalOut } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useAuthRedirect, useQuery } from "@/lib/use-query";

import { ConflictsTab } from "./_components/ConflictsTab";
import { EntityDrawer } from "./_components/EntityDrawer";
import { FlaggedTab } from "./_components/FlaggedTab";
import { GraphTab } from "./_components/GraphTab";
import { ProposalsTab } from "./_components/ProposalsTab";

type Tab = "graph" | "flagged" | "conflicts" | "proposals";

export default function BaselinePage() {
  const { me, role } = useMe();
  const canWrite = hasRole(role, "approver");
  const onAuth = useAuthRedirect();

  const graph = useQuery("baseline-graph", () => unwrap(api.GET("/v1/baseline/graph")));
  const trace = useQuery("baseline-trace", () => unwrap(api.GET("/v1/baseline/trace")));
  const conflicts = useQuery("baseline-conflicts", () => unwrap(api.GET("/v1/baseline/conflicts")));
  const proposals = useQuery("baseline-proposals", () =>
    unwrap(api.GET("/v1/baseline/proposals", { params: { query: { status: "open" } } })),
  );

  const [tab, setTab] = useState<Tab>("graph");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { reload: reloadGraph } = graph;
  const { reload: reloadTrace } = trace;
  const { reload: reloadConflicts } = conflicts;
  const { reload: reloadProposals } = proposals;
  const refresh = useCallback(() => {
    void Promise.all([reloadGraph(), reloadTrace(), reloadConflicts(), reloadProposals()]);
  }, [reloadGraph, reloadTrace, reloadConflicts, reloadProposals]);
  const close = useCallback(() => setOpenId(null), []);

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
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "graph", label: "Graph" },
    { id: "flagged", label: "Flagged", count: trace.data?.summary.flagged },
    { id: "conflicts", label: "Conflicts", count: openConflicts },
    { id: "proposals", label: "Proposals", count: proposals.data?.length },
  ];
  const openEntity = openId ? graph.data?.entities.find((e) => e.id === openId) : undefined;
  const low = trace.data?.low;

  return (
    <div className={`mx-auto max-w-5xl px-6 py-8 ${openEntity ? "xl:pr-[31rem]" : ""}`}>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-neutral-900">Baseline</h1>
      <p className="mb-5 text-sm text-neutral-600">
        Goals, products and features the product is built on, each linked to its evidence.
        {!canWrite && role && " You can read the baseline; approvers make changes."}
      </p>

      <div role="tablist" aria-label="Baseline views" className="mb-5 flex gap-1 border-b border-neutral-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? "border-neutral-900 font-medium text-neutral-900"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t.label}
            {t.count != null && (
              <span
                data-testid={`tab-count-${t.id}`}
                className={`rounded-full px-1.5 text-xs tabular-nums ${
                  t.count > 0 ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-500"
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && (
        <p role="status" className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {notice}
        </p>
      )}

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "graph" && (
          <>
            {graph.error && <ErrorNote>{graph.error}</ErrorNote>}
            {graph.loading && !graph.data && <Loading />}
            {graph.data && (
              <GraphTab
                graph={graph.data}
                trace={trace.data}
                canWrite={canWrite}
                meId={me?.user_id}
                busy={busy}
                onOpen={setOpenId}
                onConfirm={confirmGoal}
              />
            )}
          </>
        )}
        {tab === "flagged" && (
          <>
            {trace.error && <ErrorNote>{trace.error}</ErrorNote>}
            {trace.loading && !trace.data && <Loading />}
            {trace.data && <FlaggedTab trace={trace.data} onOpen={setOpenId} />}
          </>
        )}
        {tab === "conflicts" && (
          <>
            {conflicts.error && <ErrorNote>{conflicts.error}</ErrorNote>}
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
            {proposals.error && <ErrorNote>{proposals.error}</ErrorNote>}
            {proposals.loading && !proposals.data && <Loading />}
            {proposals.data && (
              <ProposalsTab
                proposals={proposals.data}
                graph={graph.data}
                canWrite={canWrite}
                busy={busy}
                onOpen={setOpenId}
                onDecide={decide}
              />
            )}
          </>
        )}
      </div>

      {openEntity && (
        <EntityDrawer
          key={openEntity.id}
          entity={openEntity}
          graph={graph.data}
          low={low}
          canWrite={canWrite}
          meId={me?.user_id}
          onClose={close}
          onOpen={setOpenId}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
