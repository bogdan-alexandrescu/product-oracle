"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { BuildRoadmapButton } from "@/components/BuildRoadmap";
import { LinkIssueDialog } from "@/components/LinkIssueDialog";
import { Chip, InfoTip, LinkButton, Notice, PageHeader, Panel, SegmentedControl, Sheet, Split } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { usePlanScope, type PlanScope } from "@/lib/preferences";
import { useQuery } from "@/lib/use-query";

import { GoalsPanel } from "../home/_goals-panel";
import { useGoals } from "../home/_use-goals";
import { PlanInspector } from "./_inspector";
import type { PlanItem } from "./_lib";
import { PrdCards } from "./_prd-cards";
import { grouped, PlanTable, type GroupBy } from "./_table";

/** The goals band; with no confirmed goal, one line and the way to the Baseline. */
function GoalsBand({ canImport }: { canImport: boolean }) {
  const { goals, history, error, loading } = useGoals("plan");
  if (goals && !goals.some((g) => !g.proposed)) {
    return (
      <Panel title="Goals" testId="plan-goals">
        <div data-testid="plan-goals-empty" className="flex flex-wrap items-center gap-3 px-4 py-4">
          <span className="text-[15px] font-semibold text-text2">No confirmed goals</span>
          <Link href="/baseline" className="ml-auto font-semibold text-accent-ink underline-offset-2 hover:underline">
            Baseline
          </Link>
        </div>
      </Panel>
    );
  }
  return <GoalsPanel goals={goals} history={history} error={error} loading={loading} canImport={canImport} testId="plan-goals" />;
}

/** Approved PRDs that have no roadmap yet: each can build one (shown while the Plan has no items). */
function BuildRoadmaps() {
  const prds = useQuery("plan|documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const roadmaps = useQuery("plan|documents|roadmap", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "roadmap" } } })));
  if (!prds.data || !roadmaps.data) return null;
  const built = new Set(roadmaps.data.map((r) => r.source?.slug).filter(Boolean));
  const open = prds.data.filter((d) => d.approved_version != null && !built.has(d.slug));
  if (open.length === 0) return null;
  return (
    <ul className="flex flex-col border-t border-line">
      {open.map((d) => (
        <li key={d.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate font-semibold">{d.title}</span>
          <BuildRoadmapButton prd={d} size="sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Plan (F1, c7 Plan rename): where the plan stands in one view. The goals band (Home's), the
 * PRDs in play with their stage, and every roadmap item under Now / Next / Later with its
 * state, engineering status and the next decision, with the selected item in the inspector.
 * One call (GET /v1/plan) plus the goals band's; the inspector reads the item's history.
 */
export default function PlanPage() {
  const { me, role, engineeringLead } = useMe();
  const userId = me?.user_id ?? null;
  const canWrite = hasRole(role, "approver");
  // F7: approvers, owners and engineering leads link and unlink tracker issues.
  const canLink = canWrite || (engineeringLead && hasRole(role, "commenter"));
  const [scope, setScope, ready] = usePlanScope(userId ?? (me ? "token" : null));
  const q = useQuery(
    `plan|${ready ? scope : "wait"}`,
    () => (ready ? unwrap(api.GET("/v1/plan", { params: { query: { scope } } })) : new Promise<never>(() => {})),
    { keepPrevious: true },
  );
  const { goals, history } = useGoals("plan");
  const latestReport = useQuery("alignment-reports|latest", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 1 } } })));
  const tags = useMemo(() => new Map((goals ?? []).map((g) => [g.id, g])), [goals]);
  const [by, setBy] = useState<GroupBy>("horizon");
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [linking, setLinking] = useState<PlanItem | null>(null);

  const data = q.data;
  const prdOrder = useMemo(() => (data?.prds ?? []).map((p) => p.document.slug), [data]);
  const ordered = data ? grouped(data.items, by, tags, prdOrder).rows : [];
  const item = ordered.find((i) => i.id === picked) ?? ordered[0] ?? null;
  const onSelect = useCallback((id: string) => {
    setPicked(id);
    if (window.matchMedia("(max-width: 600px)").matches) setSheet(true);
  }, []);
  const counts = data?.counts;
  const reload = q.reload;
  const onLink = useCallback(
    (i: PlanItem) => {
      setSheet(false);
      setLinking(i);
    },
    [],
  );
  const links = canLink ? { onLink, onChanged: reload } : undefined;
  const inspector = item ? (
    <PlanInspector key={item.id} item={item} goals={tags} history={history} me={userId} links={links} />
  ) : undefined;

  return (
    <div className="min-w-0 px-6 pb-6 max-[600px]:px-2.5 max-[600px]:pb-24">
      <PageHeader
        title="Plan"
        status={
          counts && (
            <>
              <Chip kind="acc" data-testid="plan-count-prds">
                {counts.prds} {counts.prds === 1 ? "PRD" : "PRDs"}
              </Chip>
              {counts.at_risk > 0 && (
                <Chip kind="crit" data-testid="plan-count-at-risk">
                  {counts.at_risk} at risk
                </Chip>
              )}
              {counts.proposed > 0 && (
                <Chip kind="warn" data-testid="plan-count-proposed">
                  {counts.proposed} proposed
                </Chip>
              )}
            </>
          )
        }
        action={
          <>
            {/* F6: the latest weekly alignment report, the Plan's header button. */}
            <LinkButton href={latestReport.data?.[0] ? `/plan/reports/${latestReport.data[0].id}` : "/plan/reports"}>
              Alignment report
            </LinkButton>
            <SegmentedControl<PlanScope>
              label="Plan scope"
              size="sm"
              value={scope}
              onChange={setScope}
              items={[
                { value: "all", label: "Approved + drafts" },
                { value: "approved", label: "Approved only" },
              ]}
            />
          </>
        }
      />
      <div className="flex flex-col gap-4 max-[600px]:gap-3">
        {q.error && <Notice tone="error">{q.error}</Notice>}
        <GoalsBand canImport={canWrite} />
        <PrdCards prds={data?.prds} canWrite={canWrite} />
        <Split inspector={inspector && <div className="max-[600px]:hidden">{inspector}</div>}>
          <Panel
            title="Roadmap"
            tools={
              <>
                <span data-testid="plan-legend" className="text-sm text-text2 max-[600px]:hidden">
                  Dashed: proposed by a draft, not approved
                </span>
                <SegmentedControl<GroupBy>
                  label="Group by"
                  size="sm"
                  value={by}
                  onChange={setBy}
                  items={[
                    { value: "horizon", label: "Horizon" },
                    { value: "goal", label: "Goal" },
                    { value: "prd", label: "PRD" },
                  ]}
                />
                <InfoTip label="the roadmap">
                  Every item of each roadmap&apos;s approved version, and of its latest draft when Approved + drafts is
                  on. A draft&apos;s item replaces its approved twin and says how it differs.
                </InfoTip>
              </>
            }
          >
            <PlanTable
              items={data?.items}
              by={by}
              tags={tags}
              prdOrder={prdOrder}
              selected={item?.id ?? null}
              onSelect={onSelect}
              me={userId}
              loading={q.loading}
              onLink={canLink ? onLink : undefined}
            />
            {data && data.items.length === 0 && <BuildRoadmaps />}
          </Panel>
        </Split>
      </div>
      <Sheet open={sheet && !!item} title={item?.title ?? "Item"} onClose={() => setSheet(false)} testId="sheet-plan-item">
        {inspector}
      </Sheet>
      {linking && <LinkIssueDialog item={linking} items={data?.items ?? []} onClose={() => setLinking(null)} onLinked={reload} />}
    </div>
  );
}
