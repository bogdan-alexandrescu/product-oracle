"use client";

import type { TraceReport } from "@/lib/api/client";

import { ConfidenceBadge, FlagBadges, NodeStatusBadge, Panel } from "./common";

/** Features that serve no confirmed goal or rest on weak evidence, and goal coverage. */
export function FlaggedTab({ trace, onOpen }: { trace: TraceReport; onOpen: (id: string) => void }) {
  const s = trace.summary;
  const stats: [string, number][] = [
    ["Features", s.features],
    ["Flagged", s.flagged],
    ["Serve no goal", s.serves_no_goal],
    ["Weak evidence", s.weak_evidence],
    ["Goals", s.goals],
    ["Confirmed goals", s.confirmed_goals],
    ["Uncovered goals", s.uncovered_goals],
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-4 gap-3 sm:grid-cols-7" aria-label="Summary">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
            <dt className="text-xs text-neutral-500">{label}</dt>
            <dd className="text-lg font-semibold text-neutral-900 tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <Panel title="Flagged features">
        {trace.flagged.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            Nothing flagged: every feature serves a confirmed goal and rests on solid evidence.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200" aria-label="Flagged features">
            {trace.flagged.map((f) => (
              <li key={f.id} data-testid={`flagged-${f.key}`} className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
                <button type="button" onClick={() => onOpen(f.id)} className="font-medium text-neutral-900 hover:underline">
                  {f.title}
                </button>
                <NodeStatusBadge status={f.status} />
                <ConfidenceBadge value={f.confidence} low={trace.low} />
                <FlagBadges flags={f.flags} />
                <span className="ml-auto text-xs text-neutral-500">
                  {f.evidence_count} piece{f.evidence_count === 1 ? "" : "s"} of evidence
                  {f.goals.length > 0 && ` · supports ${f.goals.map((g) => g.title).join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Goal coverage">
        <table className="w-full text-sm" aria-label="Goal coverage">
          <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Goal</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Features</th>
              <th className="px-4 py-2 text-right font-medium">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200">
            {trace.goals.map((g) => (
              <tr key={g.id} data-testid={`coverage-${g.key}`}>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => onOpen(g.id)} className="text-neutral-900 hover:underline">
                    {g.title}
                  </button>
                  {g.features.length > 0 && (
                    <div className="text-xs text-neutral-500">
                      {g.features.map((f) => `${f.title} (${f.contribution})`).join(", ")}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <NodeStatusBadge status={g.status} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums" data-col="features">
                  {g.features.length}
                </td>
                <td className="px-4 py-2 text-right tabular-nums" data-col="coverage">
                  {g.coverage}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
