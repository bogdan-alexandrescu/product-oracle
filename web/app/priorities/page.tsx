"use client";

import { Fragment, useState } from "react";

import { Badge, Button, ErrorNote, Loading } from "@/components/ui";
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

type Tone = "neutral" | "green" | "amber" | "red" | "blue";
const FLAGS: Record<string, { label: string; tone: Tone; title: string }> = {
  no_confirmed_goal: {
    label: "Serves no confirmed goal",
    tone: "red",
    title: "Linked to no confirmed goal, so it is ranked after every feature that serves one.",
  },
  dependency_cycle: {
    label: "Dependency cycle",
    tone: "red",
    title: "Part of a set of features that depend on each other.",
  },
  missing_inputs: { label: "Missing inputs", tone: "amber", title: "Some inputs this method needs are not set." },
  no_confidence: { label: "No confidence data", tone: "amber", title: "No evidence or confidence value: 0.5 assumed." },
  low_confidence: { label: "Low confidence", tone: "amber", title: "Confidence below 0.4." },
  moved_for_dependency: {
    label: "Moved for a dependency",
    tone: "blue",
    title: "Placed earlier than its score because a higher-ranked feature depends on it.",
  },
};

const CONFIDENCE_SOURCE: Record<Schemas["ConfidenceUsed"]["source"], string> = {
  evidence: "from evidence",
  baseline: "from the baseline",
  attrs: "set on the feature",
  default: "assumed",
};

function FlagBadge({ flag }: { flag: string }) {
  const f = FLAGS[flag] ?? { label: flag.replace(/_/g, " "), tone: "neutral" as const, title: flag };
  return (
    <Badge tone={f.tone} title={f.title}>
      {f.label}
    </Badge>
  );
}

const fmt = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n * 100) / 100));

function inputValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Explanation({ f }: { f: RankedFeature }) {
  const e = f.explanation;
  const inputs = Object.entries(e.inputs ?? {}) as [string, Record<string, unknown> | null][];
  return (
    <div data-testid={`explanation-${f.key}`} className="grid gap-5 px-4 py-4 text-sm md:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">How the score was worked out</h3>
          <p className="mb-1 font-mono text-xs text-neutral-500">{e.formula}</p>
          <ol className="list-decimal space-y-0.5 pl-5 font-mono text-xs text-neutral-800" aria-label="Steps">
            {e.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {e.missing.length > 0 && (
            <p className="mt-1 text-xs text-amber-800">Missing: {e.missing.join(", ")}</p>
          )}
        </div>
        {inputs.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Inputs</h3>
            <table className="w-full text-xs">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Input</th>
                  <th className="py-1 pr-3 font-medium">Value</th>
                  <th className="py-1 font-medium">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {inputs.map(([name, v]) => (
                  <tr key={name}>
                    <td className="py-1 pr-3 text-neutral-700">{name.replace(/_/g, " ")}</td>
                    <td className="py-1 pr-3 font-mono">{inputValue(v?.value)}</td>
                    <td className="py-1 text-neutral-500">
                      {name === "goal_value"
                        ? "goal terms"
                        : v?.attr
                          ? <span className="font-mono">attrs.{String(v.attr)}</span>
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {e.order && e.order.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Order</h3>
            <ul className="list-disc pl-5 text-neutral-700">
              {e.order.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="space-y-4">
        <div>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Confidence used</h3>
          <p className="text-neutral-800">
            <span className="font-mono">{fmt(e.confidence.value)}</span>{" "}
            <span className="text-neutral-500">({CONFIDENCE_SOURCE[e.confidence.source]})</span>
          </p>
          <p className="text-xs text-neutral-500">{e.confidence.explain}</p>
          {e.confidence.evidence.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs">
              {e.confidence.evidence.map((ev) => (
                <li key={ev.id} className="flex gap-2">
                  <span className="font-mono text-neutral-700">{ev.id}</span>
                  <span className="text-neutral-500">{fmt(ev.confidence)}</span>
                  {ev.ref && (
                    <a href={ev.ref} target="_blank" rel="noreferrer" className="truncate text-sky-700 hover:underline">
                      {ev.ref}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">Goals</h3>
          {e.goals.length === 0 ? (
            <p className="text-rose-800">Serves no confirmed goal.</p>
          ) : (
            <ul className="space-y-1">
              {e.goals.map((g) => (
                <li key={g.goal} className="text-neutral-800">
                  <span className="font-mono text-xs text-neutral-500">{g.goal}</span> {g.title}
                  <div className="font-mono text-xs text-neutral-600">
                    weight {g.weight}
                    {g.weight_assumed && <AssumedMark />} × contribution {g.contribution}
                    {g.contribution_assumed && <AssumedMark />} = {fmt(g.term)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function AssumedMark() {
  return (
    <span className="ml-1 rounded bg-amber-50 px-1 font-sans text-[10px] text-amber-800 ring-1 ring-amber-200 ring-inset">
      assumed
    </span>
  );
}

function Snapshots({ reloadKey }: { reloadKey: number }) {
  const q = useQuery(`priority-snapshots|${reloadKey}`, () => unwrap(api.GET("/v1/priorities/snapshots")));
  return (
    <section className="mt-10" aria-labelledby="snapshots-heading">
      <h2 id="snapshots-heading" className="mb-3 text-sm font-semibold text-neutral-700">
        Recent snapshots
      </h2>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}
      {q.data && q.data.length === 0 && (
        <p className="text-sm text-neutral-600">No snapshots yet. Save one to keep a record of today&apos;s ranking.</p>
      )}
      {q.data && q.data.length > 0 && (
        <ul data-testid="snapshot-list" className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {q.data.slice(0, 10).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="text-neutral-900">{formatDateTime(s.created_at)}</span>
              <Badge>{METHOD_LABEL[s.method]}</Badge>
              <span className="text-neutral-500">{s.feature_count} features</span>
              <span className="font-mono text-xs text-neutral-600">top: {s.top.join(", ") || "—"}</span>
              {s.note && <span className="text-neutral-600">“{s.note}”</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PrioritiesPage() {
  const [method, setMethod] = useState<Method>("goal_weighted");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Schemas["SnapshotOut"] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [snapshotsKey, setSnapshotsKey] = useState(0);
  const { role } = useMe();
  const canSnapshot = hasRole(role, "approver");

  const q = useQuery(`priorities|${method}`, () =>
    unwrap(api.GET("/v1/priorities", { params: { query: { method } } })),
  );
  const r = q.data;

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-neutral-900">Priorities</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Features from the baseline, ranked by the method you pick and put in dependency order. Expand a row to see how
        its score was worked out.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div role="radiogroup" aria-label="Ranking method" className="inline-flex rounded-md border border-neutral-300 bg-white p-0.5">
          {METHODS.map((m) => (
            <button
              key={m.method}
              type="button"
              role="radio"
              aria-checked={method === m.method}
              data-testid={`method-${m.method}`}
              onClick={() => {
                setMethod(m.method);
                setSaved(null);
              }}
              className={`rounded px-3 py-1 text-sm font-medium ${
                method === m.method ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor="snapshot-note">
            Snapshot note
          </label>
          <input
            id="snapshot-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            disabled={!canSnapshot}
            className="w-48 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <Button
            variant="primary"
            onClick={saveSnapshot}
            disabled={!canSnapshot || saving || !r}
            title={canSnapshot ? "Keep a dated copy of this ranking" : "Approvers and owners can save snapshots"}
          >
            {saving ? "Saving…" : "Save snapshot"}
          </Button>
        </div>
      </div>

      {saved && (
        <p role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Snapshot saved: {METHOD_LABEL[saved.method]} ranking of {saved.feature_count} features, top{" "}
          {saved.top.slice(0, 3).join(", ")}.
        </p>
      )}
      {saveError && <ErrorNote>{saveError}</ErrorNote>}

      {r && (
        <p className="mb-4 text-sm text-neutral-600">
          Formula:{" "}
          <code data-testid="formula" className="rounded bg-neutral-100 px-1.5 py-0.5 text-[13px] text-neutral-800">
            {r.formula}
          </code>
        </p>
      )}

      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}

      {r && r.cycles.length > 0 && (
        <div
          role="alert"
          data-testid="cycles-banner"
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <strong className="font-semibold">Dependency cycle{r.cycles.length > 1 ? "s" : ""}:</strong>{" "}
          {r.cycles.map((c, i) => (
            <span key={i}>
              {i > 0 && "; "}
              <span className="font-mono">{c.join(" → ")}</span>
            </span>
          ))}
          . These features depend on each other, so they are ordered by score until the cycle is broken.
        </div>
      )}

      {r && r.features.length === 0 && (
        <div className="space-y-2 text-neutral-600">
          <p>No features to rank yet. Features come from the baseline: confirm some and link them to goals.</p>
        </div>
      )}

      {r && r.features.length > 0 && (
        <>
          <p className="mb-2 text-xs text-neutral-500">
            {r.counts.features} features · {r.counts.no_goal} serve no confirmed goal · {r.counts.unscored} unscored ·{" "}
            {r.counts.in_cycles} in a cycle · ranked {formatDateTime(r.generated_at)}
          </p>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full text-sm" data-testid="priority-table">
              <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Feature</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 text-right font-medium">Confidence</th>
                  <th className="px-3 py-2 font-medium">Goals</th>
                  <th className="px-3 py-2 font-medium">Depends on</th>
                  <th className="px-3 py-2 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {r.features.map((f) => {
                  const expanded = open.has(f.key);
                  return (
                    <Fragment key={f.key}>
                      <tr data-testid={`priority-row-${f.key}`} className={expanded ? "bg-neutral-50" : "hover:bg-neutral-50"}>
                        <td className="px-3 py-2.5 align-top text-neutral-500 tabular-nums">
                          {f.rank}
                          {f.rank !== f.score_rank && (
                            <span className="block text-[10px] text-neutral-400" title="Rank by score alone">
                              score #{f.score_rank}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={`explanation-row-${f.key}`}
                            onClick={() => toggle(f.key)}
                            className="flex items-start gap-1.5 text-left"
                          >
                            <span aria-hidden className="mt-0.5 w-3 text-neutral-400">
                              {expanded ? "▾" : "▸"}
                            </span>
                            <span>
                              <span className="font-medium text-neutral-900 hover:underline">{f.title}</span>
                              <span className="block font-mono text-[11px] text-neutral-400">{f.key}</span>
                            </span>
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-right align-top font-mono tabular-nums" data-testid="score">
                          {fmt(f.score)}
                        </td>
                        <td className="px-3 py-2.5 text-right align-top font-mono tabular-nums">
                          {fmt(f.explanation.confidence.value)}
                        </td>
                        <td className="px-3 py-2.5 align-top text-xs text-neutral-700">
                          {f.explanation.goals.map((g) => g.goal).join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2.5 align-top font-mono text-xs text-neutral-600">
                          {f.depends_on.join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <div className="flex flex-wrap gap-1">
                            {f.flags.map((flag) => (
                              <FlagBadge key={flag} flag={flag} />
                            ))}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr id={`explanation-row-${f.key}`} className="bg-neutral-50">
                          <td colSpan={7} className="p-0">
                            <Explanation f={f} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Snapshots reloadKey={snapshotsKey} />
    </div>
  );
}
