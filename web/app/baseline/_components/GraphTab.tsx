"use client";

import { Badge, Button } from "@/components/ui";
import type { EntityOut, GraphOut, TraceFeature, TraceReport } from "@/lib/api/client";

import { ConfidenceBadge, DEFAULT_LOW, FlagBadges, formatValue, LockBadge, NodeStatusBadge, Panel } from "./common";

type Props = {
  graph: GraphOut;
  trace: TraceReport | undefined;
  canWrite: boolean;
  meId?: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onConfirm: (goal: EntityOut) => void;
};

const byTitle = (a: EntityOut, b: EntityOut) => a.title.localeCompare(b.title);

/** Goals, then products with their features (feature part_of product). */
export function GraphTab({ graph, trace, canWrite, meId, busy, onOpen, onConfirm }: Props) {
  const low = trace?.low ?? DEFAULT_LOW;
  const live = graph.entities.filter((e) => e.status !== "rejected");
  const goals = live
    .filter((e) => e.type === "goal")
    .sort((a, b) => Number(b.attrs?.weight ?? 0) - Number(a.attrs?.weight ?? 0) || byTitle(a, b));
  const products = live.filter((e) => e.type === "product").sort(byTitle);
  const features = live.filter((e) => e.type === "feature").sort(byTitle);
  const traceById = new Map((trace?.features ?? []).map((f) => [f.id, f]));
  const coverage = new Map((trace?.goals ?? []).map((g) => [g.id, g]));

  const productOf = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.type !== "part_of" || e.status === "rejected") continue;
    if (products.some((p) => p.id === e.dst_id) && !productOf.has(e.src_id)) productOf.set(e.src_id, e.dst_id);
  }
  const groups: { id: string; product: EntityOut | null; features: EntityOut[] }[] = products.map((p) => ({
    id: p.id,
    product: p,
    features: features.filter((f) => productOf.get(f.id) === p.id),
  }));
  const unassigned = features.filter((f) => !productOf.has(f.id));
  if (unassigned.length > 0) groups.push({ id: "unassigned", product: null, features: unassigned });

  return (
    <div className="space-y-6">
      <Panel title="Goals">
        {goals.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">No goals yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200" aria-label="Goals">
            {goals.map((g) => {
              const cov = coverage.get(g.id);
              return (
                <li key={g.id} data-testid={`goal-${g.key}`} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpen(g.id)}
                        className="font-medium text-neutral-900 hover:underline"
                      >
                        {g.title}
                      </button>
                      <NodeStatusBadge status={g.status} />
                      <ConfidenceBadge value={g.confidence} low={low} />
                      <LockBadge entity={g} meId={meId} />
                    </div>
                    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-600">
                      {(
                        [
                          ["Weight", "weight"],
                          ["Metric", "metric"],
                          ["Target", "target"],
                          ["Horizon", "horizon"],
                        ] as const
                      ).map(([label, key]) => (
                        <div key={key} className="flex gap-1">
                          <dt className="text-neutral-400">{label}</dt>
                          <dd data-attr={key}>{formatValue(g.attrs?.[key])}</dd>
                        </div>
                      ))}
                      {cov && (
                        <div className="flex gap-1">
                          <dt className="text-neutral-400">Features</dt>
                          <dd>
                            {cov.features.length} (coverage {cov.coverage})
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>
                  {canWrite && g.status === "proposed" && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm(g)}>
                      Confirm
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Products and features">
        {groups.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">No products or features yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-200" aria-label="Products">
            {groups.map((group) => (
              <li key={group.id} data-testid={group.product ? `product-${group.product.key}` : "product-unassigned"}>
                <div className="flex items-center gap-1.5 bg-neutral-50/60 px-4 py-2">
                  {group.product ? (
                    <>
                      <button
                        type="button"
                        onClick={() => onOpen(group.product!.id)}
                        className="font-semibold text-neutral-900 hover:underline"
                      >
                        {group.product.title}
                      </button>
                      <NodeStatusBadge status={group.product.status} />
                      <LockBadge entity={group.product} meId={meId} />
                    </>
                  ) : (
                    <span className="font-semibold text-neutral-600">Unassigned</span>
                  )}
                  <span className="ml-auto text-xs text-neutral-400">
                    {group.features.length} feature{group.features.length === 1 ? "" : "s"}
                  </span>
                </div>
                {group.features.length > 0 && (
                  <ul aria-label={`Features of ${group.product?.title ?? "Unassigned"}`}>
                    {group.features.map((f) => (
                      <FeatureRow
                        key={f.id}
                        feature={f}
                        trace={traceById.get(f.id)}
                        low={low}
                        meId={meId}
                        onOpen={onOpen}
                      />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function FeatureRow({
  feature,
  trace,
  low,
  meId,
  onOpen,
}: {
  feature: EntityOut;
  trace: TraceFeature | undefined;
  low: number;
  meId?: string | null;
  onOpen: (id: string) => void;
}) {
  const delivery = feature.attrs?.status;
  return (
    <li data-testid={`feature-${feature.key}`} className="flex flex-wrap items-center gap-1.5 py-2 pr-4 pl-10">
      <button type="button" onClick={() => onOpen(feature.id)} className="text-neutral-900 hover:underline">
        {feature.title}
      </button>
      <NodeStatusBadge status={feature.status} />
      {delivery != null && <Badge>{formatValue(delivery).replace(/_/g, " ")}</Badge>}
      <ConfidenceBadge value={feature.confidence} low={low} />
      <LockBadge entity={feature} meId={meId} />
      {trace && <FlagBadges flags={trace.flags} />}
      {trace && trace.goals.length > 0 && (
        <span className="ml-auto text-xs text-neutral-500">
          {trace.goals.map((g) => `${g.title} (${g.contribution})`).join(", ")}
        </span>
      )}
    </li>
  );
}
