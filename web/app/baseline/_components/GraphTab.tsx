"use client";

import { useState, type FormEvent, type MouseEvent, type ReactNode } from "react";

import { Button, Chip, CodeChip, DataTable, InfoTip, Panel, type Column } from "@/components/ds";
import type { EdgeOut, EntityOut, GraphOut, TraceFeature, TraceReport } from "@/lib/api/client";
import { named, namedText, type Named } from "@/lib/codes";
import { goalTree, percent } from "@/lib/goal-tree";

import type { AddKind } from "./AddItem";
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
  /** Opens Add item on this kind (the tables' Add). */
  onAdd: (kind: AddKind) => void;
  /** B5: read the goals' `*_text` values into typed fields (approvers). */
  onFill?: () => void;
  /** B6: Make measurable on a Not measurable chip (commenters and up). */
  onMakeMeasurable?: (goal: EntityOut) => void;
  /** B6: the vague goals and the header's Interview vague goals (commenters and up). */
  vague?: number;
  onInterviewVague?: () => void;
  /** #345: add a subgoal under a goal (approvers); resolves true once it is saved. */
  onAddSubgoal?: (parent: EntityOut, title: string) => Promise<boolean>;
};

/** #345: a new subgoal's title, under the goal it is added to. */
function AddSubgoal({
  parent,
  busy,
  onAdd,
  onCancel,
}: {
  /** The parent's code and name, as its chip reads. */
  parent: Named;
  busy: boolean;
  onAdd: (title: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) onAdd(title.trim());
  };
  return (
    <form aria-label="Add subgoal" onSubmit={submit} className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3 max-[600px]:px-3">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
        <span className="text-text2">
          Subgoal of {namedText(parent)}
        </span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Subgoal title"
          className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-text"
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
        Add
      </Button>
      <Button type="button" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

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
function TitleButton({
  entity,
  onOpen,
  className = "",
  name,
}: {
  entity: EntityOut;
  onOpen: (id: string) => void;
  className?: string;
  /** The words to show (a goal's name after its code chip); the title by default. */
  name?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(entity.id);
      }}
      className={`${className.includes("min-w-") ? "" : "min-w-0"} truncate text-left hover:underline ${className}`}
    >
      {name ?? entity.title}
    </button>
  );
}

/**
 * The feature × goal Ledger (B1): features grouped by product, a column per goal with
 * each supports link's contribution, then the goals with their metric, target and horizon.
 * On a phone the grid becomes a list: each feature's title, then its goal links as small
 * G-tags with their strength.
 */
export function GraphTab({ graph, trace, canWrite, meId, busy, selectedId, tags, onOpen, onConfirm, onAdd, onFill, onMakeMeasurable, vague = 0, onInterviewVague, onAddSubgoal }: Props) {
  const low = trace?.low ?? DEFAULT_LOW;
  const live = graph.entities.filter((e) => e.status !== "rejected");
  const goals = sortedGoals(graph);
  // #345: the goals table is a tree; a goal's subgoals fold under it.
  const tree = new Map(goalTree(graph.entities).map((n) => [n.goal.id, n]));
  const codes = new Map([...tree].map(([id, n]) => [id, n.code]));
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<EntityOut | null>(null);
  const goalRows = goals.filter((g) => {
    const parent = tree.get(g.id)?.parentId;
    return !parent || !folded.has(parent);
  });
  const fold = (id: string, open?: boolean) =>
    setFolded((f) => {
      const next = new Set(f);
      if (open ?? next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      cell: (g) => {
        const vague = g.goal_check?.measurable === false;
        const indent = tree.get(g.id)?.depth ? "pl-6" : "";
        const chip = (
          <Chip kind="warn" title={missingTip(g.goal_check)} data-testid="not-measurable">
            Not measurable
          </Chip>
        );
        const head = (
          <span className={`flex min-w-0 items-center gap-2 ${indent}`}>
            {(tree.get(g.id)?.children ?? 0) > 0 && (
              <button
                type="button"
                aria-expanded={!folded.has(g.id)}
                aria-label={`${folded.has(g.id) ? "Show" : "Hide"} subgoals of ${namedText(tree.get(g.id)!)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  fold(g.id);
                }}
                className="-ml-1 flex size-6 flex-none items-center justify-center rounded text-text2 hover:bg-surface2"
              >
                {folded.has(g.id) ? "▸" : "▾"}
              </button>
            )}
            <CodeChip
              kind="goal"
              entityId={g.id}
              entityKey={g.key}
              title={g.title}
              code={tree.get(g.id)?.code}
              proposed={g.status === "proposed"}
              codeOnly
            />
            {/* The title keeps room beside an indent and its chips (#345); the chips give way first. */}
            <TitleButton entity={g} name={tags.get(g.id)} onOpen={onOpen} className="min-w-[8rem] font-medium" />
            {vague && !onMakeMeasurable && <span className="flex-none">{chip}</span>}
            <LockMark entity={g} meId={meId} />
          </span>
        );
        if (!vague || !onMakeMeasurable) return head;
        // B6: the chip and its Make measurable on a line of their own, so the title keeps its room;
        // a subgoal's line keeps its indent.
        return (
          <span className="flex min-w-0 flex-col gap-1 py-1">
            {head}
            <span className={`flex min-w-0 items-center gap-1 ${indent}`}>
              <span className="flex-none">{chip}</span>
              <Button
                variant="ghost"
                disabled={busy}
                data-testid="make-measurable"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  onMakeMeasurable(g);
                }}
              >
                Make measurable
              </Button>
            </span>
          </span>
        );
      },
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
      key: "progress",
      header: "Progress",
      width: "120px",
      phoneLabel: "Progress",
      cell: (g) =>
        g.progress?.value != null ? (
          <span
            data-attr="progress"
            data-source={g.progress.source}
            className="tnum whitespace-nowrap"
            title={g.progress.source === "subgoals" ? "Rolled up from its subgoals" : "Its own measurement"}
          >
            {percent(g.progress.value)}
            <span className="ml-1 text-text2">{g.progress.source === "subgoals" ? "subgoals" : "own"}</span>
          </span>
        ) : (
          <span data-attr="progress" className="text-text2">
            –
          </span>
        ),
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
      width: "232px",
      className: "overflow-visible",
      align: "right",
      phone: "action",
      cell: (g) => (
        <span className="flex flex-wrap justify-end gap-2">
          {g.status === "proposed" && (
            <Button
              disabled={busy}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onConfirm(g);
              }}
            >
              Confirm
            </Button>
          )}
          {onAddSubgoal && !tree.get(g.id)?.depth && (
            <Button
              disabled={busy}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                setAdding(g);
              }}
            >
              Add subgoal
            </Button>
          )}
        </span>
      ),
    });
  }

  // Only a role that can add sees Add (#370).
  const add = (kind: AddKind) =>
    canWrite ? (
      <Button icon="plus" onClick={() => onAdd(kind)}>
        Add
      </Button>
    ) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Feature × goal"
        count={features.length}
        tools={
          <>
            <InfoTip label="Feature × goal">
              Each bar group is a feature&apos;s contribution to a goal, 0 (none) to 3 (strong). Rings show confidence.
            </InfoTip>
            {add("feature")}
          </>
        }
      >
        {groups.length === 0 ? (
          <p className="px-4 py-8 text-center text-text2">No features yet</p>
        ) : (
          <Ledger
            goals={goals}
            groups={groups}
            tags={tags}
            codes={codes}
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
          <>
            {onInterviewVague && vague > 0 && (
              <>
                <Button disabled={busy} onClick={onInterviewVague}>
                  {`Interview vague goals (${vague})`}
                </Button>
                <InfoTip label="the goals interview">
                  Oracle asks one question at a time and proposes measurable versions. Nothing runs until you start.
                </InfoTip>
              </>
            )}
            {add("goal")}
            {canWrite && onFill && toFill > 0 && (
              <>
              <Button disabled={busy} onClick={onFill}>
                {`Fill from text (${toFill} ${toFill === 1 ? "goal" : "goals"})`}
              </Button>
              <InfoTip label="Fill from text">
                Oracle reads the goals&apos; targets, values and horizons still written as text, with the rules Home uses. A
                locked goal gets a proposal instead. Ranges and owner names stay as text.
              </InfoTip>
              </>
            )}
          </>
        }
      >
        {adding && onAddSubgoal && (
          <AddSubgoal
            key={adding.id}
            parent={tree.get(adding.id) ?? named(adding.title, adding.key)}
            busy={busy}
            onCancel={() => setAdding(null)}
            onAdd={async (title) => {
              if (await onAddSubgoal(adding, title)) {
                fold(adding.id, true);
                setAdding(null);
              }
            }}
          />
        )}
        <DataTable
          label="Goals"
          columns={goalCols}
          rows={goalRows}
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
  codes,
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
  /** #345: each goal's code, a subgoal's "G-B.1" (lib/goal-tree). */
  codes: Map<string, string | null>;
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
                  <span className="max-[600px]:hidden">
                    <CodeChip kind="goal" entityId={g.id} entityKey={g.key} title={g.title} code={codes.get(g.id)} proposed={g.status === "proposed"} codeOnly />
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpen(g.id)}
                    className="line-clamp-2 text-left font-semibold text-text hover:underline max-[600px]:sr-only"
                  >
                    {tags.get(g.id) ?? g.title}
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
                codes={codes}
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
  codes,
  links,
  trace,
  low,
  meId,
  selected,
  onOpen,
}: {
  feature: EntityOut;
  goals: EntityOut[];
  codes: Map<string, string | null>;
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
                <CodeChip kind="goal" entityId={g.id} entityKey={g.key} title={g.title} code={codes.get(g.id)} proposed={g.status === "proposed"} wrap />
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
