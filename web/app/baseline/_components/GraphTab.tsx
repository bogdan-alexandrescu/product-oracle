"use client";

import type { MouseEvent, ReactNode } from "react";

import { Button, Chip, DataTable, GoalTag, InfoTip, Panel, type Column } from "@/components/ds";
import type { EdgeOut, EntityOut, GraphOut, TraceFeature, TraceReport } from "@/lib/api/client";

import {
  ConfidenceRing,
  contributionOf,
  ContributionPips,
  DEFAULT_LOW,
  DeliveryChip,
  NodeStatusBadge,
  FlagBadges,
  formatValue,
  LockMark,
  sortedGoals,
} from "./common";
import { fillable, horizonLabel, missingTip, OwnerName, typedTarget, useOwners } from "./goal-fields";
import { byTitle } from "./order";

type Props = {
  graph: GraphOut;
  trace: TraceReport | undefined;
  canWrite: boolean;
  meId?: string | null;
  busy: boolean;
  selectedId?: string | null;
  tags: Map<string, string>;
  onOpen: (id: string) => void;
  onConfirm: (goal: EntityOut) => void;
  /** B5: read the goals' `*_text` values into typed fields (approvers). */
  onFill?: () => void;
};

/** A goal's typed cell, or its text in grey with the tooltip saying it is not checked yet. */
function TextFallback({ attr, text }: { attr: string; text: unknown }) {
  if (text == null || text === "") return <span data-attr={attr} className="text-text2">–</span>;
  return (
    <span data-attr={attr} data-text="true" className="truncate text-text2" title="Not checked yet: fill from text or edit">
      {String(text)}
    </span>
  );
}

/** A title that opens the item in the inspector; one line. */
function TitleButton({ entity, onOpen, className = "" }: { entity: EntityOut; onOpen: (id: string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(entity.id);
      }}
      className={`min-w-0 truncate text-left hover:underline ${className}`}
    >
      {entity.title}
    </button>
  );
}

/**
 * The feature × goal Ledger (B1): features grouped by product, a column per goal with
 * each supports link's contribution, then the goals with their metric, target and horizon.
 * On a phone the grid becomes a list: each feature's title, then its goal links as small
 * G-tags with their strength.
 */
export function GraphTab({ graph, trace, canWrite, meId, busy, selectedId, tags, onOpen, onConfirm, onFill }: Props) {
  const low = trace?.low ?? DEFAULT_LOW;
  const live = graph.entities.filter((e) => e.status !== "rejected");
  const goals = sortedGoals(graph);
  const products = live.filter((e) => e.type === "product").sort(byTitle);
  const features = live.filter((e) => e.type === "feature").sort(byTitle);
  const traceById = new Map((trace?.features ?? []).map((f) => [f.id, f]));
  const coverage = new Map((trace?.goals ?? []).map((g) => [g.id, g]));
  const owners = useOwners(goals.map((g) => g.attrs?.owner).filter((x): x is string => typeof x === "string"));
  const toFill = fillable(goals);

  const productOf = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.type !== "part_of" || e.status === "rejected") continue;
    if (products.some((p) => p.id === e.dst_id) && !productOf.has(e.src_id)) productOf.set(e.src_id, e.dst_id);
  }
  /** feature id -> goal id -> its supports edge */
  const links = new Map<string, Map<string, EdgeOut>>();
  for (const e of graph.edges) {
    if (e.type !== "supports" || e.status === "rejected") continue;
    if (!links.has(e.src_id)) links.set(e.src_id, new Map());
    links.get(e.src_id)!.set(e.dst_id, e);
  }
  const groups: { id: string; product: EntityOut | null; features: EntityOut[] }[] = products.map((p) => ({
    id: p.id,
    product: p,
    features: features.filter((f) => productOf.get(f.id) === p.id),
  }));
  const unassigned = features.filter((f) => !productOf.has(f.id));
  if (unassigned.length > 0) groups.push({ id: "unassigned", product: null, features: unassigned });

  const goalCols: Column<EntityOut>[] = [
    {
      key: "goal",
      header: "Goal",
      cell: (g) => (
        <span className="flex min-w-0 items-center gap-2">
          <GoalTag id={tags.get(g.id) ?? "G"} proposed={g.status === "proposed"} />
          <TitleButton entity={g} onOpen={onOpen} className="font-medium" />
          {g.goal_check?.measurable === false && (
            <span className="flex-none">
              <Chip kind="warn" title={missingTip(g.goal_check)} data-testid="not-measurable">
                Not measurable
              </Chip>
            </span>
          )}
          <LockMark entity={g} meId={meId} />
        </span>
      ),
    },
    {
      key: "status",
      header: "State",
      width: "120px",
      cell: (g) => <NodeStatusBadge status={g.status} />,
    },
    {
      key: "metric",
      header: "Metric",
      hideOnPhone: true,
      cell: (g) => (
        <span data-attr="metric" title={formatValue(g.attrs?.metric)} className="text-text2">
          {formatValue(g.attrs?.metric)}
        </span>
      ),
    },
    {
      key: "target",
      header: "Target",
      width: "100px",
      phoneLabel: "Target",
      cell: (g) => {
        const t = typedTarget(g.attrs ?? {});
        if (!t) return <TextFallback attr="target" text={g.attrs?.target_text ?? g.attrs?.target} />;
        return (
          <span data-attr="target" className="tnum font-semibold whitespace-nowrap" title={t.words}>
            {t.short}
          </span>
        );
      },
    },
    {
      key: "horizon",
      header: "Horizon",
      width: "132px",
      hideOnPhone: true,
      cell: (g) => {
        const h = horizonLabel(g.attrs ?? {});
        if (!h) return <TextFallback attr="horizon" text={g.attrs?.horizon_text ?? g.attrs?.horizon} />;
        return (
          <span data-attr="horizon" className="tnum whitespace-nowrap">
            {h}
          </span>
        );
      },
    },
    {
      key: "owner",
      header: "Owner",
      width: "120px",
      hideOnPhone: true,
      cell: (g) => <OwnerName id={g.attrs?.owner} owners={owners} />,
    },
    {
      key: "weight",
      header: "Weight",
      width: "76px",
      align: "right",
      hideOnPhone: true,
      cell: (g) => (
        <span data-attr="weight" className="tnum">
          {formatValue(g.attrs?.weight)}
        </span>
      ),
    },
    {
      key: "features",
      header: "Features",
      width: "84px",
      align: "right",
      hideOnPhone: true,
      cell: (g) => <span className="tnum">{coverage.get(g.id)?.features.length ?? "–"}</span>,
    },
    {
      key: "confidence",
      header: "Conf.",
      width: "64px",
      align: "center",
      hideOnPhone: true,
      cell: (g) => <ConfidenceRing value={g.confidence} low={low} size={32} />,
    },
  ];
  if (canWrite) {
    goalCols.push({
      key: "act",
      header: <span className="sr-only">Action</span>,
      // The whole button: nothing in the action column truncates.
      width: "128px",
      className: "overflow-visible",
      align: "right",
      phone: "action",
      cell: (g) =>
        g.status === "proposed" ? (
          <Button
            disabled={busy}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              onConfirm(g);
            }}
          >
            Confirm
          </Button>
        ) : null,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Feature × goal"
        count={features.length}
        tools={
          <InfoTip label="Feature × goal">
            Each bar group is a feature&apos;s contribution to a goal, 0 (none) to 3 (strong). Rings show confidence.
          </InfoTip>
        }
      >
        {groups.length === 0 ? (
          <p className="px-4 py-8 text-center text-text2">No features yet</p>
        ) : (
          <Ledger
            goals={goals}
            groups={groups}
            tags={tags}
            links={links}
            traceById={traceById}
            low={low}
            meId={meId}
            selectedId={selectedId}
            onOpen={onOpen}
          />
        )}
      </Panel>

      <Panel
        title="Goals"
        count={goals.length}
        tools={
          canWrite &&
          onFill &&
          toFill > 0 && (
            <>
              <Button disabled={busy} onClick={onFill}>
                {`Fill from text (${toFill} ${toFill === 1 ? "goal" : "goals"})`}
              </Button>
              <InfoTip label="Fill from text">
                Oracle reads the goals&apos; targets, values and horizons still written as text, with the rules Home uses. A
                locked goal gets a proposal instead. Ranges and owner names stay as text.
              </InfoTip>
            </>
          )
        }
      >
        <DataTable
          label="Goals"
          columns={goalCols}
          rows={goals}
          rowKey={(g) => g.id}
          selected={selectedId}
          onSelect={(id) => onOpen(id)}
          rowProps={(g) => ({ "data-testid": `goal-${g.key}` })}
          empty="No goals yet"
        />
      </Panel>
    </div>
  );
}

function Ledger({
  goals,
  groups,
  tags,
  links,
  traceById,
  low,
  meId,
  selectedId,
  onOpen,
}: {
  goals: EntityOut[];
  groups: { id: string; product: EntityOut | null; features: EntityOut[] }[];
  tags: Map<string, string>;
  links: Map<string, Map<string, EdgeOut>>;
  traceById: Map<string, TraceFeature>;
  low: number;
  meId?: string | null;
  selectedId?: string | null;
  onOpen: (id: string) => void;
}) {
  const cols = 3 + goals.length;
  const th = "bg-surface2 px-2 text-[13px] leading-4 font-semibold text-text2";
  return (
    <div className="min-w-0 overflow-clip">
      <table
        aria-label="Feature × goal"
        role="table"
        className="w-full table-fixed border-collapse text-[15px] leading-[22px] max-[600px]:block"
      >
        <colgroup>
          <col />
          <col className="w-[132px] max-[600px]:hidden" />
          <col className="w-[64px] max-[600px]:hidden" />
          {goals.map((g) => (
            <col key={g.id} className="w-[124px] max-[1100px]:w-[96px] max-[600px]:w-[52px]" />
          ))}
        </colgroup>
        <thead className="max-[600px]:sr-only">
          <tr>
            <th scope="col" className={`${th} h-9 pl-4 text-left align-bottom max-[600px]:pl-3`}>
              Feature
            </th>
            <th scope="col" className={`${th} text-left align-bottom max-[600px]:hidden`}>
              State
            </th>
            <th scope="col" className={`${th} text-center align-bottom max-[600px]:hidden`}>
              Conf.
            </th>
            {goals.map((g) => (
              <th
                key={g.id}
                scope="col"
                className={`${th} border-l border-line py-2.5 text-left align-top last:pr-4 max-[600px]:px-1 max-[600px]:text-center max-[600px]:last:pr-1`}
              >
                <span className="flex flex-col gap-1.5 max-[600px]:items-center">
                  <GoalTag id={tags.get(g.id) ?? "G"} proposed={g.status === "proposed"} title={g.title} />
                  <button
                    type="button"
                    onClick={() => onOpen(g.id)}
                    className="line-clamp-2 text-left font-semibold text-text hover:underline max-[600px]:sr-only"
                  >
                    {g.title}
                  </button>
                  {(typedTarget(g.attrs ?? {}) || g.attrs?.target != null || g.attrs?.target_text != null) && (
                    <span className="tnum text-text2 max-[600px]:hidden">
                      Target{" "}
                      <b className="font-semibold text-text">
                        {typedTarget(g.attrs ?? {})?.short ?? formatValue(g.attrs?.target_text ?? g.attrs?.target)}
                      </b>
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody
            key={group.id}
            data-testid={group.product ? `product-${group.product.key}` : "product-unassigned"}
            aria-label={`Features of ${group.product?.title ?? "Unassigned"}`}
            role="rowgroup"
            className="max-[600px]:block"
          >
            <tr role="row" className="border-t border-line bg-surface2 max-[600px]:block">
              <th
                colSpan={cols}
                scope="colgroup"
                className="h-9 px-4 text-left max-[600px]:flex max-[600px]:items-center max-[600px]:px-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {group.product ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onOpen(group.product!.id)}
                        className="min-w-0 truncate font-display tracking-heading font-bold hover:underline"
                      >
                        {group.product.title}
                      </button>
                      {group.product.status === "proposed" && <Chip kind="warn">Proposed</Chip>}
                      <LockMark entity={group.product} meId={meId} />
                    </>
                  ) : (
                    <span className="font-display tracking-heading font-bold text-text2">Unassigned</span>
                  )}
                  <span className="tnum ml-auto text-sm font-semibold text-text2">{group.features.length}</span>
                </span>
              </th>
            </tr>
            {group.features.map((f) => (
              <FeatureRow
                key={f.id}
                feature={f}
                goals={goals}
                tags={tags}
                links={links.get(f.id)}
                trace={traceById.get(f.id)}
                low={low}
                meId={meId}
                selected={selectedId === f.id}
                onOpen={onOpen}
              />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function FeatureRow({
  feature,
  goals,
  tags,
  links,
  trace,
  low,
  meId,
  selected,
  onOpen,
}: {
  feature: EntityOut;
  goals: EntityOut[];
  tags: Map<string, string>;
  links: Map<string, EdgeOut> | undefined;
  trace: TraceFeature | undefined;
  low: number;
  meId?: string | null;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const flags = trace?.flags ?? [];
  return (
    <tr
      data-testid={`feature-${feature.key}`}
      data-selected={selected || undefined}
      onClick={() => onOpen(feature.id)}
      role="row"
      className={`h-12 cursor-pointer border-t border-line hover:bg-surface2 max-[600px]:flex max-[600px]:h-auto max-[600px]:flex-wrap max-[600px]:items-center max-[600px]:gap-x-2 max-[600px]:gap-y-1.5 max-[600px]:px-3 max-[600px]:py-2.5 ${
        selected ? "bg-accent-soft shadow-[inset_4px_0_0_var(--accent)] hover:bg-accent-soft" : ""
      }`}
    >
      <td role="cell" className="px-2 py-1.5 pl-4 max-[600px]:block max-[600px]:basis-full max-[600px]:p-0">
        <span className="flex min-w-0 items-center gap-2 max-[600px]:flex-wrap">
          <TitleButton entity={feature} onOpen={onOpen} className="max-[600px]:font-medium max-[600px]:whitespace-normal" />
          <LockMark entity={feature} meId={meId} />
          {feature.status === "proposed" && (
            <span className="flex-none max-[600px]:hidden">
              <Chip kind="warn">Proposed</Chip>
            </span>
          )}
          {flags.length > 0 && (
            <span className="flex min-w-0 flex-none gap-1.5 max-[600px]:flex-wrap">
              <FlagBadges flags={flags} />
            </span>
          )}
        </span>
      </td>
      <td role="cell" className="truncate px-2 py-1.5 max-[600px]:hidden">
        <DeliveryChip value={feature.attrs?.status} />
      </td>
      <td role="cell" className="px-2 py-1.5 text-center max-[600px]:hidden">
        <ConfidenceRing value={feature.confidence} low={low} size={32} />
      </td>
      {goals.map((g) => {
        const e = links?.get(g.id);
        return (
          <td
            key={g.id}
            role="cell"
            className={`border-l border-line px-2 py-1.5 text-center max-[600px]:border-0 max-[600px]:p-0 ${
              e ? "max-[600px]:block" : "max-[600px]:hidden"
            }`}
          >
            <span className="max-[600px]:hidden">{e ? <LinkCell edge={e} low={low} /> : <Dot />}</span>
            {e && (
              <span className="hidden items-center gap-1.5 rounded-goal border border-line py-0.5 pr-2 pl-0.5 max-[600px]:inline-flex">
                <GoalTag id={tags.get(g.id) ?? "G"} proposed={g.status === "proposed"} title={g.title} />
                <ContributionPips value={contributionOf(e.attrs)} proposed={e.status === "proposed"} />
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

/** A supports link: its confidence ring when scored, else its contribution 0-3. */
function LinkCell({ edge, low }: { edge: EdgeOut; low: number }): ReactNode {
  if (edge.confidence != null) return <ConfidenceRing value={edge.confidence} low={low} size={32} />;
  return <ContributionPips value={contributionOf(edge.attrs)} proposed={edge.status === "proposed"} />;
}

function Dot() {
  return (
    <span className="inline-block size-1.5 rounded-full bg-line-strong align-middle" aria-label="No link" role="img" />
  );
}
