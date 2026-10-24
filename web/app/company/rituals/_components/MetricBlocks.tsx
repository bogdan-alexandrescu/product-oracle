"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, Sparkline, ViewOnly } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { addDays, calendarDay, todayIn, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

type Variance = Schemas["VarianceOut"];

/** A metrics_table row as oracle.metrics.review builds it. */
export type MetricRow = {
  metric_id: string;
  title: string;
  kind: "output" | "input";
  unit: string;
  state: "ok" | "no_value" | "pull_failed";
  value: number | null;
  change: number | null;
  change_pct: number | null;
  vs_6w_avg: number | null;
  vs_6w_avg_pct: number | null;
  vs_last_year: number | null;
  vs_last_year_pct: number | null;
  /** The last 12 weeks' values, oldest first (null: no value that week). */
  spark: (number | null)[];
  variance: "better" | "worse" | null;
  href: string;
};

/** A variances row: the variance as GET /v1/metric-variances returns it, under `variance_id`. */
export type VarianceRow = Omit<Variance, "id"> & { variance_id: string; owner_name?: string | null };

const DIRECTION = { better: "Better", worse: "Worse" } as const;
const DIRECTION_KIND = { better: "pass", worse: "crit" } as const;
const EXPLAIN_MIN = 10;
const EXPLAIN_MAX = 1000;
const FIND_OUT_DAYS = 7;
const FIND_OUT_MAX = 28;

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const signed = (v: number) => (v > 0 ? `+${num(v)}` : num(v));
const valueText = (v: number, unit: string) => (unit === "%" ? `${num(v)}%` : `${num(v)} ${unit}`);
const vs = (v: number | null, pct: number | null) => (v == null ? "—" : pct == null ? signed(v) : `${signed(v)} (${signed(pct)}%)`);

/** The fixed format (research [62]): outputs first, each followed by its inputs, with the 12-week sparkline; wraps on a phone, never scrolls sideways. */
export function MetricsTable({ rows }: { rows: MetricRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-line" data-testid="metrics-review-table">
      {rows.map((r) => {
        const known = r.spark.filter((v): v is number => v != null);
        return (
          <li key={r.metric_id} className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 ${r.kind === "input" ? "pl-9" : ""}`}>
            <Link href={r.href} className="min-w-0 flex-[1_1_12rem] font-medium [overflow-wrap:anywhere] hover:underline">
              {r.title}
            </Link>
            {known.length > 1 && <Sparkline values={known} label={`Trend ${known.join(", ")}`} />}
            {r.state === "pull_failed" ? (
              <span className="text-sm text-crit">Not read</span>
            ) : r.value == null ? (
              <span className="text-sm text-text2">No value this week</span>
            ) : (
              <>
                <span className="tnum text-[15px] font-semibold">{valueText(r.value, r.unit)}</span>
                <span className="tnum text-sm" title="Against the week before">
                  {vs(r.change, r.change_pct)}
                </span>
                <span className="tnum text-sm text-text2" title="Against the 6-week average">
                  6-wk avg {vs(r.vs_6w_avg, r.vs_6w_avg_pct)}
                </span>
                {r.vs_last_year != null && (
                  <span className="tnum text-sm text-text2" title="Against the same week last year">
                    Year {vs(r.vs_last_year, r.vs_last_year_pct)}
                  </span>
                )}
                {r.variance && <Chip kind={DIRECTION_KIND[r.variance]}>{DIRECTION[r.variance]}</Chip>}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The period's variances, one card each, read live (the pre-read keeps what was true when it
 * was built). The metric's owner (whatever their role), approvers and owners Explain or
 * choose Don't know yet; approvers mark Noise. Everyone else reads the cards (#370: no
 * controls, not disabled ones).
 */
export function VarianceCards({ rows, live, onChanged }: { rows: VarianceRow[]; live: Map<string, Variance>; onChanged: () => Promise<void> }) {
  const { me, can } = useMe();
  const cards = rows.map((r) => live.get(r.variance_id) ?? ({ ...r, id: r.variance_id } as Variance));
  const acts =
    cards.some((v) => can("explain_metric_variance", v.owner_id === me?.user_id) || can("mark_metric_variance_unknown", v.owner_id === me?.user_id)) ||
    can("mark_metric_variance_noise");
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {!acts && (
        <div>
          <ViewOnly />
        </div>
      )}
      {cards.map((v) => (
        <VarianceCard key={v.id} variance={v} ownerName={rows.find((r) => r.variance_id === v.id)?.owner_name ?? null} onChanged={onChanged} />
      ))}
    </div>
  );
}

function VarianceCard({ variance: v, ownerName, onChanged }: { variance: Variance; ownerName: string | null; onChanged: () => Promise<void> }) {
  const { me, can } = useMe();
  const zone = useCompanyZone();
  const today = todayIn(zone);
  const explains = can("explain_metric_variance", v.owner_id === me?.user_id);
  const unknown = can("mark_metric_variance_unknown", v.owner_id === me?.user_id);
  const answers = explains || unknown;
  const noise = can("mark_metric_variance_noise");
  const draft = v.oracle_draft ?? "";
  const [text, setText] = useState(v.explanation ?? draft);
  const [mode, setMode] = useState<"unknown" | "noise" | null>(null);
  const [day, setDay] = useState(addDays(today, FIND_OUT_DAYS));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { variance_id: v.id } } };
  const open = v.status === "open" || v.status === "unknown";

  async function run(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      setMode(null);
      invalidateWaiting();
      await onChanged();
      waitingChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const status =
    v.status === "explained"
      ? "Explained"
      : v.status === "noise"
        ? "Noise"
        : v.status === "unknown"
          ? `Finding out by ${v.find_out_by ? calendarDay(v.find_out_by) : "—"}`
          : "Not explained yet";
  const drafted = !!draft && text === draft && v.status !== "explained";
  const unit = (n: number) => num(n);

  return (
    <article data-testid="variance-card" data-status={v.status} className="min-w-0 rounded-lg border border-line px-3 py-2.5">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{v.metric_title}</h3>
        <Chip kind={DIRECTION_KIND[v.direction]} data-testid="variance-direction">
          {DIRECTION[v.direction]}
        </Chip>
        <span className="text-sm text-text2" data-testid="variance-status">
          {status}
        </span>
      </header>
      <p className="tnum mt-1 text-sm">
        Week of {calendarDay(v.week_start)}: {unit(v.value)} from {unit(v.previous)} ({signed(v.change)}
        {v.change_pct != null ? `, ${signed(v.change_pct)}%` : ""})
        {v.band && <span className="text-text2"> · normal range {unit(v.band.low)} to {unit(v.band.high)}</span>}
      </p>
      {ownerName && <p className="text-sm text-text2">Owner: {ownerName}</p>}
      {v.possible_causes.length > 0 && (
        <div className="mt-2">
          <h4 className="text-[13px] font-semibold text-text2">Possible causes</h4>
          <ul className="flex flex-col gap-0.5 text-sm">
            {v.possible_causes.map((c, i) => (
              <li key={i} data-testid="variance-cause" className="[overflow-wrap:anywhere]">
                <Link href={c.href} className="text-accent-ink hover:underline">
                  {c.title}
                </Link>{" "}
                <span className="text-text2">· {calendarDay(c.on)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.status === "explained" && v.explanation && (
        <p className="mt-2 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {v.explanation}
          {v.explained_by_name && <span className="block text-[13px] text-text2">Explained by {v.explained_by_name}</span>}
        </p>
      )}
      {v.status === "noise" && v.noise_reason && <p className="mt-2 text-[15px] [overflow-wrap:anywhere]">{v.noise_reason}</p>}
      {!explains && open && draft && (
        <p className="mt-2 text-[15px] [overflow-wrap:anywhere]">
          {draft}
          <span className="block text-[13px] text-text2">Drafted by Oracle</span>
        </p>
      )}
      {answers && open && (
        <div className="mt-2 flex flex-col gap-2">
          {explains && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Explanation
              <textarea className={`${INPUT} min-h-20`} maxLength={EXPLAIN_MAX} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {explains && drafted && <p className="text-[13px] text-text2">Drafted by Oracle</p>}
          {mode === "unknown" && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Find out by
              <input type="date" className={`${INPUT} w-auto`} min={addDays(today, 1)} max={addDays(today, FIND_OUT_MAX)} value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          )}
          {mode === "noise" && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
              Why it is noise
              <input className={INPUT} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {mode === null ? (
              <>
                {explains && (
                  <Button
                    variant="solid"
                    disabled={busy || text.trim().length < EXPLAIN_MIN}
                    onClick={() => run(() => unwrap(api.POST("/v1/metric-variances/{variance_id}/explain", { ...path, body: { explanation: text.trim(), lock_version: v.lock_version } })))}
                  >
                    Explain
                  </Button>
                )}
                {unknown && (
                  <Button disabled={busy} onClick={() => setMode("unknown")}>
                    Don&apos;t know yet
                  </Button>
                )}
                {noise && (
                  <Button variant="ghost" disabled={busy} onClick={() => setMode("noise")}>
                    Noise
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  variant="solid"
                  disabled={busy || (mode === "noise" ? !reason.trim() : !day)}
                  onClick={() =>
                    run(() =>
                      mode === "noise"
                        ? unwrap(api.POST("/v1/metric-variances/{variance_id}/noise", { ...path, body: { reason: reason.trim(), lock_version: v.lock_version } }))
                        : unwrap(api.POST("/v1/metric-variances/{variance_id}/unknown", { ...path, body: { find_out_by: day, lock_version: v.lock_version } })),
                    )
                  }
                >
                  Save
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setMode(null)}>
                  Back
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </article>
  );
}
