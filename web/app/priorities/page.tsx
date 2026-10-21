"use client";

import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import {
  Button,
  Chip,
  DataTable,
  GoalTag,
  Icon,
  InfoTip,
  Inspector,
  InspectorSection,
  Label,
  Meter,
  Notice,
  Page,
  PageHeader,
  Panel,
  Ring,
  Split,
  type ChipKind,
  type Column,
} from "@/components/ds";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

type Method = Schemas["PriorityRanking"]["method"];
type RankedFeature = Schemas["RankedFeature"];

const METHODS: { method: Method; label: string }[] = [
  { method: "goal_weighted", label: "Goal-weighted" },
  { method: "rice", label: "RICE" },
  { method: "moscow", label: "MoSCoW" },
  { method: "wsjf", label: "WSJF" },
];
const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.method, m.label])) as Record<Method, string>;

const FLAGS: Record<string, { label: string; kind: ChipKind; title: string }> = {
  no_confirmed_goal: {
    label: "Serves no confirmed goal",
    kind: "crit",
    title: "Linked to no confirmed goal, so it is ranked after every feature that serves one.",
  },
  dependency_cycle: {
    label: "Dependency cycle",
    kind: "crit",
    title: "Part of a set of features that depend on each other.",
  },
  missing_inputs: { label: "Missing inputs", kind: "warn", title: "Some inputs this method needs are not set." },
  no_confidence: { label: "No confidence data", kind: "warn", title: "No evidence or confidence value: 50 assumed." },
  low_confidence: { label: "Low confidence", kind: "warn", title: "Confidence below 40." },
  moved_for_dependency: {
    label: "Moved for a dependency",
    kind: "acc",
    title: "Placed earlier than its score because a higher-ranked feature depends on it.",
  },
};

const CONFIDENCE_SOURCE: Record<Schemas["ConfidenceUsed"]["source"], string> = {
  evidence: "from evidence",
  baseline: "from the baseline",
  attrs: "set on the feature",
  default: "assumed",
};

const flagOf = (flag: string) => FLAGS[flag] ?? { label: flag.replace(/_/g, " "), kind: "na" as const, title: flag };

function FlagChip({ flag, hero = false }: { flag: string; hero?: boolean }) {
  const f = flagOf(flag);
  return (
    <Chip kind={f.kind} hero={hero} title={f.title}>
      {f.label}
    </Chip>
  );
}

const fmt = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 100) / 100));
/** Confidence 0-1 as 0-100: the one scale the page shows it in (ring, bar, figures). */
const pct = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100));

/**
 * A score step with its confidence factor on the page's 0-100 scale: "score = 6 × 0.75 ÷ 2"
 * reads "score = 6 × 75% ÷ 2" (the same arithmetic).
 */
function stepText(step: string, confidence: number | null | undefined): string {
  if (confidence == null || !/^score\b/.test(step)) return step;
  // The last "× c": confidence is the last factor in every formula (impact comes before it in RICE).
  const factor = [` × ${confidence}`, ` × ${fmt(confidence)}`].find((f) => step.includes(f));
  if (!factor) return step;
  const at = step.lastIndexOf(factor);
  const end = at + factor.length;
  if (end < step.length && step[end] !== " ") return step;
  return `${step.slice(0, at)} × ${pct(confidence)}%${step.slice(end)}`;
}

function inputValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The ranking method: a radio group drawn as B1's segmented control. */
function MethodSwitch({ value, onChange }: { value: Method; onChange: (m: Method) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const at = METHODS.findIndex((m) => m.method === value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = METHODS[(at + step + METHODS.length) % METHODS.length]!;
    onChange(next.method);
    ref.current?.querySelector<HTMLElement>(`[data-testid="method-${next.method}"]`)?.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label="Ranking method"
      onKeyDown={onKey}
      className="inline-flex max-w-full flex-none overflow-x-auto rounded-button border border-line-strong bg-surface"
    >
      {METHODS.map((m) => {
        const on = value === m.method;
        return (
          <button
            key={m.method}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-testid={`method-${m.method}`}
            onClick={() => onChange(m.method)}
            className={`flex h-9 items-center border-r border-line px-3.5 text-[15px] font-medium max-[600px]:px-2.5 max-[600px]:text-sm whitespace-nowrap last:border-r-0 ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

/** The selected feature: rank, confidence, score, then how the score was worked out. */
function FeatureInspector({ f, id }: { f: RankedFeature; id: string }) {
  const e = f.explanation;
  const inputs = Object.entries(e.inputs ?? {}) as [string, Record<string, unknown> | null][];
  return (
    <div id={id}>
      <Inspector
        eyebrow="Feature · selected"
        title={f.title}
        label={`Feature ${f.title}`}
        testId="priority-inspector"
        chips={
          <>
            <Chip hero kind="na">
              {f.key}
            </Chip>
            {f.flags.map((flag) => (
              <FlagChip key={flag} flag={flag} hero />
            ))}
          </>
        }
        stats={[
          { label: "Rank", value: `#${f.rank}` },
          { label: "Confidence", figure: <Ring value={pct(e.confidence.value)} size={46} /> },
          { label: "Score", value: fmt(f.score) },
        ]}
      >
        <div data-testid={`explanation-${f.key}`}>
          <InspectorSection
            label="Score"
            tools={
              <InfoTip label="Formula">
                <span className="font-mono">{e.formula}</span>
                {f.rank !== f.score_rank && <span className="mt-1 block">Rank by score alone: #{f.score_rank}</span>}
              </InfoTip>
            }
          >
            <ol className="list-decimal space-y-1 pl-5 font-mono text-[13px] leading-5" aria-label="Steps">
              {e.steps.map((s, i) => (
                <li key={i}>{stepText(s, e.confidence.value)}</li>
              ))}
            </ol>
            {e.missing.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1.5">
                <Chip kind="warn">Missing</Chip>
                <span className="font-mono text-[13px]">{e.missing.join(", ")}</span>
              </p>
            )}
          </InspectorSection>

          {inputs.length > 0 && (
            <InspectorSection label="Inputs">
              <table className="w-full table-fixed text-[13px] leading-5">
                <thead className="text-left text-text2">
                  <tr>
                    <th className="py-1 pr-2 font-semibold">Input</th>
                    <th className="w-[72px] py-1 pr-2 font-semibold">Value</th>
                    <th className="py-1 font-semibold">From</th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map(([name, v]) => (
                    <tr key={name} className="border-t border-line">
                      <td className="truncate py-1 pr-2">{name.replace(/_/g, " ")}</td>
                      <td className="tnum truncate py-1 pr-2 font-mono">
                        {name === "confidence" && typeof v?.value === "number" ? pct(v.value) : inputValue(v?.value)}
                      </td>
                      <td className="truncate py-1 text-text2">
                        {name === "goal_value" ? (
                          "goal terms"
                        ) : v?.attr ? (
                          <span className="font-mono">attrs.{String(v.attr)}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </InspectorSection>
          )}

          {e.order && e.order.length > 0 && (
            <InspectorSection label="Order">
              <ul className="space-y-1.5 text-sm">
                {e.order.map((o, i) => (
                  <OrderReason key={i} reason={o} />
                ))}
              </ul>
            </InspectorSection>
          )}

          <InspectorSection
            label="Confidence"
            tools={
              <InfoTip label="Confidence used">
                {e.confidence.explain}
              </InfoTip>
            }
          >
            <div className="flex items-center gap-2.5">
              <b className="tnum font-mono">{pct(e.confidence.value) ?? "—"}</b>
              <span className="text-sm text-text2">{CONFIDENCE_SOURCE[e.confidence.source]}</span>
            </div>
            {e.confidence.evidence.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-sm">
                {e.confidence.evidence.map((ev) => (
                  <li key={ev.id} className="flex min-w-0 items-center gap-2">
                    <span className="flex-none font-mono">{ev.id}</span>
                    <span className="tnum flex-none text-text2">{pct(ev.confidence) ?? "—"}</span>
                    {ev.ref && ev.source_removed && (
                      <span className="min-w-0 truncate text-text2">{ev.ref}</span>
                    )}
                    {ev.source_removed && (
                      <Chip kind="na" data-testid="source-removed">
                        source removed
                      </Chip>
                    )}
                    {ev.ref && !ev.source_removed && (
                      <a
                        href={ev.ref}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate text-accent-ink underline-offset-2 hover:underline"
                      >
                        {ev.ref}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>

          <InspectorSection label="Goals">
            {e.goals.length === 0 ? (
              <Chip kind="crit">Serves no confirmed goal</Chip>
            ) : (
              <ul className="space-y-2">
                {e.goals.map((g) => (
                  <li key={g.goal} className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <GoalTag id={g.goal} />
                      <span className="truncate">{g.title}</span>
                    </div>
                    <div className="tnum mt-1 flex flex-wrap items-center gap-x-1 font-mono text-[13px] text-text2">
                      weight {g.weight}
                      {g.weight_assumed && <AssumedMark />} × contribution {g.contribution}
                      {g.contribution_assumed && <AssumedMark />} = {fmt(g.term)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>
        </div>
      </Inspector>
    </div>
  );
}

function AssumedMark() {
  return (
    <span className="rounded-goal bg-warn-bg px-1.5 font-sans text-[13px] leading-5 font-semibold text-warn">assumed</span>
  );
}

type GoalRow = { id: string; title: string; count: number; top: number };

/** Each goal, the features ranked for it and its best rank. Derived from the ranking. */
function byGoal(features: RankedFeature[]): GoalRow[] {
  const m = new Map<string, GoalRow>();
  for (const f of features) {
    for (const g of f.explanation.goals) {
      const row = m.get(g.goal) ?? { id: g.goal, title: g.title, count: 0, top: f.rank };
      row.count += 1;
      row.top = Math.min(row.top, f.rank);
      m.set(g.goal, row);
    }
  }
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function Snapshots({
  reloadKey,
  note,
  onNote,
  canSnapshot,
}: {
  reloadKey: number;
  note: string;
  onNote: (v: string) => void;
  canSnapshot: boolean;
}) {
  const q = useQuery(`priority-snapshots|${reloadKey}`, () => unwrap(api.GET("/v1/priorities/snapshots")));
  const list = q.data?.slice(0, 10);
  return (
    <Panel
      title="Snapshots"
      count={q.data?.length || undefined}
      tools={
        <>
          <label className="sr-only" htmlFor="snapshot-note">
            Snapshot note
          </label>
          <input
            id="snapshot-note"
            value={note}
            onChange={(e) => onNote(e.target.value)}
            placeholder="Note"
            disabled={!canSnapshot}
            className={`${INPUT} !w-52 max-[600px]:!w-40`}
          />
        </>
      }
    >
      {q.error && (
        <div className="p-3">
          <Notice tone="error">{q.error}</Notice>
        </div>
      )}
      {q.loading && !q.data && <p className="px-4 py-3 text-text2">Loading…</p>}
      {q.data && q.data.length === 0 && <p className="px-4 py-6 text-center text-text2">No snapshots yet.</p>}
      {list && list.length > 0 && (
        <ul data-testid="snapshot-list">
          {list.map((s) => (
            <li
              key={s.id}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-1.5 first:border-t-0 max-[600px]:px-3"
            >
              <span className="tnum">{formatDateTime(s.created_at)}</span>
              <Chip kind="acc">{METHOD_LABEL[s.method]}</Chip>
              <span className="tnum text-text2">{s.feature_count} features</span>
              <span className="min-w-0 truncate font-mono text-[13px] text-text2">
                top {s.top.join(", ") || "—"}
              </span>
              {s.note && <span className="min-w-0 truncate text-text2">“{s.note}”</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function PrioritiesPage() {
  const [method, setMethod] = useState<Method>("goal_weighted");
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Schemas["PrioritySnapshotOut"] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [snapshotsKey, setSnapshotsKey] = useState(0);
  const { role } = useMe();
  const canSnapshot = hasRole(role, "approver");

  const q = useQuery(`priorities|${method}`, () =>
    unwrap(api.GET("/v1/priorities", { params: { query: { method } } })),
  );
  const r = q.data;
  const features = r?.features ?? [];
  // The selected feature, else the top of the ranking.
  const current = features.find((f) => f.key === selected) ?? features[0];
  const inspectorId = "priority-inspector";

  async function saveSnapshot() {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const snap = await unwrap(
        api.POST("/v1/priorities/snapshots", { body: { method, note: note.trim() || null } }),
      );
      setSaved(snap);
      setNote("");
      setSnapshotsKey((k) => k + 1);
    } catch (e) {
      setSaveError(e instanceof Error && e.message ? e.message : errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<RankedFeature>[] = [
    {
      key: "rank",
      header: "#",
      width: "48px",
      phone: "meta",
      cell: (f) => (
        <b className="tnum font-semibold max-[600px]:text-text">
          <span className="hidden max-[600px]:inline">#</span>
          {f.rank}
        </b>
      ),
    },
    {
      key: "feature",
      header: "Feature",
      phone: "title",
      cell: (f) => {
        const on = current?.key === f.key;
        return (
          <button
            type="button"
            aria-expanded={on}
            aria-controls={inspectorId}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              setSelected(f.key);
            }}
            className="block max-w-full truncate text-left font-medium hover:underline"
            title={`${f.title} · ${f.key}`}
          >
            {f.title}
          </button>
        );
      },
    },
    {
      key: "goal",
      header: "Goal",
      width: "80px",
      cell: (f) =>
        f.explanation.goals.length === 0 ? (
          <span className="text-text2">—</span>
        ) : (
          <span className="flex gap-1">
            {f.explanation.goals.map((g) => (
              <GoalTag key={g.goal} id={g.goal} title={`${g.goal} · ${g.title}`} />
            ))}
          </span>
        ),
    },
    {
      key: "confidence",
      header: "Confidence",
      width: "104px",
      hideOnPhone: true,
      cell: (f) => {
        const c = pct(f.explanation.confidence.value);
        return c == null ? (
          <span className="text-text2">—</span>
        ) : (
          <Meter value={c} max={100} showMax={false} label={`Confidence ${c}`} width={80} />
        );
      },
    },
    {
      key: "score",
      header: "Score",
      width: "80px",
      align: "right",
      phoneLabel: "Score",
      cell: (f) => (
        <span data-testid="score" className="tnum font-mono">
          {fmt(f.score)}
        </span>
      ),
    },
    {
      key: "deps",
      header: "Depends on",
      width: "96px",
      hideOnPhone: true,
      cell: (f) => <span className="font-mono text-[13px] text-text2">{f.depends_on.join(", ") || "—"}</span>,
    },
    {
      key: "flags",
      header: "Flags",
      width: "240px",
      cell: (f) => (
        <span className="flex items-center gap-1.5 overflow-hidden max-[600px]:flex-wrap">
          {f.flags.slice(0, 1).map((flag) => (
            <FlagChip key={flag} flag={flag} />
          ))}
          {f.flags.length > 1 && (
            <Chip kind="na" title={f.flags.slice(1).map((x) => flagOf(x).label).join(", ")}>
              +{f.flags.length - 1}
              <span className="sr-only">{f.flags.slice(1).map((x) => flagOf(x).label).join(", ")}</span>
            </Chip>
          )}
        </span>
      ),
    },
  ];

  const goals = byGoal(features);
  const counts = r?.counts;

  return (
    <Page>
      <PageHeader
        title="Priorities"
        status={
          counts && (
            <>
              <Chip kind="acc">{counts.features} ranked</Chip>
              {counts.no_goal > 0 && <Chip kind="crit">{counts.no_goal} no goal</Chip>}
              {counts.unscored > 0 && <Chip kind="warn">{counts.unscored} unscored</Chip>}
              {counts.in_cycles > 0 && <Chip kind="warn">{counts.in_cycles} in a cycle</Chip>}
            </>
          )
        }
        action={
          <>
            <Button
              variant="primary"
              icon="check"
              onClick={saveSnapshot}
              disabled={!canSnapshot || saving || !r}
              title={canSnapshot ? "Keep a dated copy of this ranking" : "Approvers and owners can save snapshots"}
            >
              {saving ? "Saving…" : "Save snapshot"}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-3">
        {saved && (
          <Notice tone="pass">
            Snapshot saved: {METHOD_LABEL[saved.method]} ranking of {saved.feature_count} features, top{" "}
            {saved.top.slice(0, 3).join(", ")}.
          </Notice>
        )}
        {saveError && <Notice tone="error">{saveError}</Notice>}
        {q.error && <Notice tone="error">{q.error}</Notice>}

        <Split
          inspector={current && <FeatureInspector key={current.key} f={current} id={inspectorId} />}
        >
          <Panel>
            <div className="flex min-h-14 flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5 max-[600px]:px-3">
              <MethodSwitch
                value={method}
                onChange={(m) => {
                  setMethod(m);
                  setSaved(null);
                }}
              />
              <span className="flex-1" />
              {r && (
                <span className="flex items-center gap-2">
                  <Label>Formula</Label>
                  <InfoTip label="Formula">
                    <code data-testid="formula" className="font-mono">
                      {r.formula}
                    </code>
                    <span className="mt-1 block">Ranked {formatDateTime(r.generated_at)}, in dependency order.</span>
                  </InfoTip>
                </span>
              )}
            </div>
            {r && r.cycles.length > 0 && (
              <div
                role="alert"
                data-testid="cycles-banner"
                className="flex flex-wrap items-center gap-2 border-b border-line bg-warn-bg px-4 py-2 text-sm font-semibold text-warn"
              >
                <Icon name="alert" size={16} />
                <span>{r.cycles.length > 1 ? "Cycles" : "Cycle"}</span>
                {r.cycles.map((c, i) => (
                  <span key={i} className="font-mono font-medium">
                    {i > 0 && "; "}
                    {c.join(" → ")}
                  </span>
                ))}
                <InfoTip label="Dependency cycle" align="start">
                  These features depend on each other, so they are ordered by score until the cycle is broken.
                </InfoTip>
              </div>
            )}
            <DataTable
              label="Ranking"
              testId="priority-table"
              columns={columns}
              rows={r?.features}
              rowKey={(f) => f.key}
              selected={current?.key ?? null}
              onSelect={(k) => setSelected(k)}
              loading={q.loading}
              empty="No features ranked"
              rowProps={(f) => ({ "data-testid": `priority-row-${f.key}` })}
            />
          </Panel>

          {goals.length > 0 && (
            <Panel title="By goal" count={goals.length}>
              <DataTable<GoalRow>
                label="By goal"
                columns={[
                  { key: "id", header: "", width: "64px", phone: "meta", cell: (g) => <GoalTag id={g.id} /> },
                  { key: "title", header: "Goal", phone: "title", cell: (g) => g.title },
                  {
                    key: "count",
                    header: "Ranked features",
                    width: "180px",
                    hideOnPhone: true,
                    cell: (g) => (
                      <Meter value={g.count} max={features.length} showMax={false} label={`${g.count} ranked features`} />
                    ),
                  },
                  { key: "top", header: "Top rank", width: "96px", align: "right", phoneLabel: "Top", cell: (g) => <span className="tnum">#{g.top}</span> },
                ]}
                rows={goals}
                rowKey={(g) => g.id}
              />
            </Panel>
          )}

          <Snapshots reloadKey={snapshotsKey} note={note} onNote={setNote} canSnapshot={canSnapshot} />
        </Split>
      </div>
    </Page>
  );
}

/**
 * The scorer's order reasons ("placed earlier because F-2 depend(s) on it") as a label and
 * feature chips (rule 1: no prose), the meaning behind an (i); a reason of another shape is
 * shown as given.
 */
const ORDER_REASONS: { re: RegExp; label: string; tip: string }[] = [
  {
    re: /^placed earlier because (.+) depend\(s\) on it$/,
    label: "Moved for",
    tip: "Ranked above its score because these features depend on it.",
  },
  {
    re: /^placed after its prerequisite\(s\) (.+)$/,
    label: "After",
    tip: "Ranked below its score because it depends on these features.",
  },
];

function OrderReason({ reason }: { reason: string }) {
  for (const r of ORDER_REASONS) {
    const m = reason.match(r.re);
    if (!m) continue;
    const keys = m[1]!.split(/,\s*/).filter(Boolean);
    return (
      <li className="flex flex-wrap items-center gap-1.5" data-reason={reason}>
        <span className="font-semibold">{r.label}</span>
        {keys.map((k) => (
          <Chip key={k} kind="line">
            <span className="font-mono">{k}</span>
          </Chip>
        ))}
        <InfoTip label={r.label}>{r.tip}</InfoTip>
      </li>
    );
  }
  return <li>{reason}</li>;
}
