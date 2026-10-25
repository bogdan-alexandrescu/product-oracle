"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { BuildRoadmapButton } from "@/components/BuildRoadmap";
import { LinkIssueDialog } from "@/components/LinkIssueDialog";
import { Chip, InfoTip, LinkButton, Notice, PageHeader, Panel, SegmentedControl, Sheet, Split, ViewOnly } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { usePlanScope, type PlanScope } from "@/lib/preferences";
import { useQuery } from "@/lib/use-query";

import { GoalsPanel } from "../home/_goals-panel";
import { useGoals } from "../home/_use-goals";
import { approvedRoadmaps, EditPlanButton, PlanChanges } from "./_edit-plan";
import { PlanInspector } from "./_inspector";
import type { PlanItem } from "./_lib";
import { PrdCards } from "./_prd-cards";
import { grouped, PlanTable, type GroupBy } from "./_table";
import { MilestoneEditor, TrackPanel, useTracks, type MilestonePick } from "./_tracks";

/** The goals band; with no confirmed goal, one line and the way to the Baseline. */
function GoalsBand({ canImport }: { canImport: boolean }) {
  const { goals, history, historyPending, error, loading } = useGoals("plan");
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
  return <GoalsPanel goals={goals} history={history} historyPending={historyPending} error={error} loading={loading} canImport={canImport} testId="plan-goals" />;
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
const noSubscribe = () => () => {};

export default function PlanPage() {
  const { me, can, capsReady } = useMe();
  const userId = me?.user_id ?? null;
  // #370: approvers start PRDs (a PRD is any approver's; only a vision, strategy or update
  // is an owner's) and build the baseline; below that the Plan is read only.
  const canWrite = can("start_draft", true);
  // create_run's handler wants an owner only to update a draft run; any other run lets
  // approvers in.
  const canBuild = can("create_run", true);
  // Import goes to /baseline?build=1, whose Build baseline shows with confirm_entity.
  const canBaseline = can("confirm_entity");
  // F7: approvers, owners and engineering leads link and unlink tracker issues.
  const canLink = can("link_tracker_issue");
  // #370 (#505): each track control shows only to a role that can call its route.
  const trackRights = useMemo(
    () => ({
      edit: can("update_track"),
      addMilestone: can("create_track_milestone"),
      check: can("monitor_track"),
      // Like create_run: an owner only for some runs, so an approver may on most tracks.
      draftRoadmap: can("create_track_roadmap_run", true),
      push: can("push_track_to_tracker"),
    }),
    [can],
  );
  const canEditMilestone = can("update_milestone");
  const [scope, setScope, ready] = usePlanScope(userId ?? (me ? "token" : null));
  const q = useQuery(
    `plan|${ready ? scope : "wait"}`,
    () => (ready ? unwrap(api.GET("/v1/plan", { params: { query: { scope } } })) : new Promise<never>(() => {})),
    { keepPrevious: true },
  );
  const { goals, history } = useGoals("plan");
  const tags = useMemo(() => new Map((goals ?? []).map((g) => [g.id, g])), [goals]);
  const [by, setBy] = useState<GroupBy>("horizon");
  // F2: /plan?item=<key> (an Inbox track alert's Open) selects that item.
  // Read on each render: a client navigation updates the URL after the first one.
  const wanted = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).get("item"), () => null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [opened, setOpened] = useState<Schemas["ChangeSetOut"] | null>(null);
  const [linking, setLinking] = useState<{ item: PlanItem; term?: string } | null>(null);
  const tracks = useTracks();
  // The tracks sit above the Roadmap: drawn before they answer, its rows would move down
  // under the pointer when they arrive.
  const tracksKnown = tracks.data !== undefined || !!tracks.error;
  const [milestone, setMilestone] = useState<MilestonePick | null>(null);

  const data = q.data;
  const prdOrder = useMemo(() => (data?.prds ?? []).map((p) => p.document.slug), [data]);
  const ordered = data ? grouped(data.items, by, tags, prdOrder).rows : [];
  const item = ordered.find((i) => i.id === picked) ?? (picked == null ? ordered.find((i) => i.key === wanted) : undefined) ?? ordered[0] ?? null;
  const onSelect = useCallback((id: string) => {
    setPicked(id);
    setMilestone(null);
    if (window.matchMedia("(max-width: 600px)").matches) setSheet(true);
  }, []);
  const onPickMilestone = useCallback((pick: MilestonePick) => {
    setMilestone(pick);
    if (window.matchMedia("(max-width: 600px)").matches) setSheet(true);
  }, []);
  const counts = data?.counts;
  const roadmaps = approvedRoadmaps(data?.items);
  const reload = q.reload;
  const onLink = useCallback(
    (i: PlanItem, term?: string) => {
      setSheet(false);
      setLinking({ item: i, term });
    },
    [],
  );
  const links = canLink ? { onLink, onChanged: reload } : undefined;
  const putTrack = (t: Schemas["TrackOverview"]) => tracks.setData((ts) => ts?.map((x) => (x.id === t.id ? t : x)));
  const msTrack = milestone ? tracks.data?.find((t) => t.id === milestone.trackId) : undefined;
  const inspector = msTrack ? (
    <MilestoneEditor
      key={`${msTrack.id}|${milestone?.id ?? "new"}`}
      track={msTrack}
      milestoneId={milestone?.id ?? null}
      // #370 (#505): a role that can never change the milestone sees it read only.
      canWrite={milestone?.id ? canEditMilestone : trackRights.addMilestone}
      onSaved={async (m) => {
        const t = await unwrap(api.GET("/v1/tracks/{track_id}", { params: { path: { track_id: m.track_id } } }));
        putTrack(t);
        setMilestone({ trackId: m.track_id, id: m.id });
      }}
    />
  ) : item ? (
    <PlanInspector key={item.id} item={item} goals={tags} history={history} me={userId} links={links} onChanged={reload} />
  ) : undefined;

  return (
    <div className="min-w-0 px-6 pb-6 max-[600px]:px-2.5 max-[600px]:pb-24">
      <PageHeader
        title="Plan"
        status={
          <>
            {capsReady && !canWrite && !canBuild && <ViewOnly />}
            {counts && (
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
            )}
          </>
        }
        action={
          <>
            {/* F6: the latest weekly alignment report, the Plan's header button. */}
            <LinkButton href="/plan/reports/latest">
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
        <GoalsBand canImport={canBaseline} />
        <PrdCards prds={data?.prds} canWrite={canWrite} />
        {roadmaps.map((r) => (
          <PlanChanges
            key={`${r.slug}|${opened?.roadmap === r.slug ? opened.id : ""}`}
            roadmap={r}
            opened={opened?.roadmap === r.slug ? opened : null}
            me={userId}
            canWrite={canWrite}
            onPlanChanged={() => void q.reload()}
          />
        ))}
        {!tracksKnown ? (
          <Loading />
        ) : (
          <Split wide inspector={inspector && <div className="max-[600px]:hidden">{inspector}</div>}>
            {tracks.error && <Notice tone="error">{tracks.error}</Notice>}
            {tracks.data?.map((t) => (
              <TrackPanel key={t.id} track={t} may={trackRights} picked={milestone} onPick={onPickMilestone} onChange={putTrack} />
            ))}
            <Panel
              title="Roadmap"
              tools={
                <>
                  {roadmaps.map((r) => (
                    <span key={r.slug} data-testid="plan-live-version" className="text-sm text-text2 max-[600px]:hidden">
                      {r.slug} v{r.version}
                    </span>
                  ))}
                  {canWrite && <EditPlanButton roadmaps={roadmaps} onOpened={setOpened} />}
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
        )}
      </div>
      {msTrack ? (
        <Sheet open={sheet} title="Milestone" onClose={() => setSheet(false)} testId="sheet-plan-milestone">
          {inspector}
        </Sheet>
      ) : (
        <Sheet open={sheet && !!item} title={item?.title ?? "Item"} onClose={() => setSheet(false)} testId="sheet-plan-item">
          {inspector}
        </Sheet>
      )}
      {linking && <LinkIssueDialog item={linking.item} term={linking.term} items={data?.items ?? []} onClose={() => setLinking(null)} onLinked={reload} />}
    </div>
  );
}
