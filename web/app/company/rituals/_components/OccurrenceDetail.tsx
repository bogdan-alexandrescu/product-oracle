"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, Chip, LinkButton, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { STATE_KIND, STATE_LABEL, localTime, zoneTime, type Occurrence } from "./lib";
import { MetricsTable, VarianceCards, type MetricRow, type VarianceRow } from "./MetricBlocks";

type Row = { text?: string; href?: string | null; method?: string; label?: string };
type Block = { key: string; title: string; as_of?: string; rows: Row[] };
/** H5: the blocks drawn as their own cards across the page (the metrics review). */
const WIDE = new Set(["metrics_table", "variances"]);

const NOTES_MAX = 10_000;

/**
 * An occurrence: its header (title, local time, length, attendees, state), the pre-read
 * blocks as cards in the kind's order, Oracle's summary, and, after the meeting, the
 * owner's notes with Mark held, Skip and Record decision. Opening it marks the pre-read
 * read for me (its Inbox row is done).
 */
export function OccurrenceDetail({ id }: { id: string }) {
  const { me, can } = useMe();
  // Read with the time it was read: the meeting has ended when the owner records it.
  const q = useQuery(`ritual-occurrence|${id}`, async () => {
    const occ = await unwrap(api.GET("/v1/ritual-occurrences/{occurrence_id}", { params: { path: { occurrence_id: id } } }));
    return { occ, at: Date.now() };
  });
  const occ = q.data?.occ;
  const reload = q.reload;
  // H5: a metrics review's variances, read live (their state moves after the pre-read is built).
  const listsVariances = !!occ?.pre_read.blocks.some((b) => (b as { key?: string }).key === "variances");
  const varianceQ = useQuery(`occurrence-variances|${id}|${listsVariances}`, () =>
    listsVariances ? unwrap(api.GET("/v1/metric-variances")) : Promise.resolve([] as Schemas["VarianceOut"][]),
  );
  const live = new Map((varianceQ.data ?? []).map((v) => [v.id, v]));
  const unread = occ ? !occ.read_by_me : false;

  useEffect(() => {
    if (!unread) return;
    void unwrap(api.POST("/v1/ritual-occurrences/{occurrence_id}/read", { params: { path: { occurrence_id: id } } }))
      .then(() => {
        invalidateWaiting();
        waitingChanged();
      })
      .catch(() => undefined);
  }, [unread, id]);

  // While Oracle writes the summary, look again every second.
  const running = occ?.summary_state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 1000);
    return () => clearInterval(t);
  }, [running, reload]);

  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!occ) return <Loading />;
  const blocks = occ.pre_read.blocks as unknown as Block[];
  const isOwner = me?.user_id === occ.owner_id;
  const ended = q.data!.at >= Date.parse(occ.ends_at);
  const recordable = isOwner && ended && (occ.status === "ready" || occ.status === "missed");

  return (
    <>
      <PageHeader
        title={occ.title}
        back={
          <Link href="/company/rituals" className="hover:underline">
            ← Rituals
          </Link>
        }
        status={
          <Chip kind={STATE_KIND[occ.status]} dot data-testid="occurrence-state">
            {STATE_LABEL[occ.status]}
          </Chip>
        }
      />
      <p className="mb-3 flex flex-wrap gap-x-3 text-sm text-text2" data-testid="occurrence-meta">
        <span className="tnum" title={zoneTime(occ.due_at, occ.timezone)}>
          {localTime(occ.due_at)}
        </span>
        <span>{occ.duration_min} min</span>
        <span>
          {occ.attendee_ids.length} {occ.attendee_ids.length === 1 ? "attendee" : "attendees"}
        </span>
      </p>
      <div className="flex flex-col gap-3">
        <SummaryCard
          occ={occ}
          canAsk={can("summarize_ritual_occurrence") && (occ.kind !== "metrics_review" || openVariances(blocks, live) > 0)}
          onChanged={reload}
        />
        {blocks.length === 0 ? (
          <Panel title="Pre-read">
            <p className="px-4 py-3 text-sm text-text2">The pre-read is not ready yet</p>
          </Panel>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
            {blocks.map((b) => (
              <BlockCard key={b.key} block={b} live={live} onChanged={varianceQ.reload} />
            ))}
          </div>
        )}
        {(occ.status === "held" || occ.status === "skipped") && <Recorded occ={occ} />}
        {recordable && <RecordForm occ={occ} onChanged={reload} />}
      </div>
    </>
  );
}

/** How many of the variances the pre-read lists nobody has answered yet. */
function openVariances(blocks: Block[], live: Map<string, Schemas["VarianceOut"]>): number {
  const rows = (blocks.find((b) => b.key === "variances")?.rows ?? []) as unknown as VarianceRow[];
  return rows.filter((r) => (live.get(r.variance_id)?.status ?? r.status) === "open").length;
}

function BlockCard({ block, live, onChanged }: { block: Block; live: Map<string, Schemas["VarianceOut"]>; onChanged: () => Promise<void> }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      data-testid="ritual-block"
      data-key={block.key}
      className={`min-w-0 rounded-panel border border-line bg-surface shadow-panel ${WIDE.has(block.key) ? "col-span-2 max-[900px]:col-span-1" : ""}`}
    >
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="font-display text-[17px] font-bold">{block.title}</h2>
        {block.as_of && <p className="text-[13px] text-text2">Data as of {localTime(block.as_of)}</p>}
      </header>
      {block.rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-text2">Nothing this time</p>
      ) : block.key === "metrics_table" ? (
        <MetricsTable rows={block.rows as unknown as MetricRow[]} />
      ) : block.key === "variances" ? (
        <VarianceCards rows={block.rows as unknown as VarianceRow[]} live={live} onChanged={onChanged} />
      ) : block.key === "suggested_next" ? (
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {block.rows.map((r) =>
            r.method === "POST" && r.href ? (
              <Button
                key={r.text}
                onClick={async () => {
                  setError(null);
                  try {
                    const res = await fetch(r.href!, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                    if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? "Oracle could not start the run");
                    const run = (await res.json()) as { id?: string };
                    if (run.id) router.push(`/runs/${run.id}`);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : errorMessage(e));
                  }
                }}
              >
                {r.label ?? r.text}
              </Button>
            ) : (
              <LinkButton key={r.text} href={r.href ?? "#"}>
                {r.label ?? r.text}
              </LinkButton>
            ),
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      ) : (
        <ul className="flex flex-col gap-1 px-4 py-3 text-[15px]">
          {block.rows.map((r, i) => (
            <li key={i} className="min-w-0 [overflow-wrap:anywhere]">
              {r.href ? (
                <Link href={r.href} className="hover:underline">
                  {r.text}
                </Link>
              ) : (
                r.text
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Oracle's summary: written, being written, failed or not started, or Summarize with Oracle.
 * A metrics review's is Explain with Oracle (its own run drafts each variance's
 * explanation); with no open variance the button is absent.
 */
function SummaryCard({ occ, canAsk, onChanged }: { occ: Occurrence; canAsk: boolean; onChanged: () => Promise<void> }) {
  const metrics = occ.kind === "metrics_review";
  const label = metrics ? "Explain with Oracle" : "Summarize with Oracle";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/ritual-occurrences/{occurrence_id}/summary", { params: { path: { occurrence_id: occ.id } } }));
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const button = canAsk && occ.pre_read.built_at && (
    <Button variant="solid" disabled={busy} onClick={ask}>
      {label}
    </Button>
  );
  return (
    <section data-testid="occurrence-summary" className="rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <h2 className="mb-1 font-display text-[17px] font-bold">Summary</h2>
      {occ.summary_state === "ready" && occ.summary ? (
        <>
          <p className="text-[15px] whitespace-pre-wrap">{occ.summary}</p>
          <p className="mt-1 text-[13px] text-text2">Written by Oracle</p>
        </>
      ) : occ.summary_state === "running" ? (
        <p className="text-sm text-text2">{metrics ? "Writing…" : "Writing the summary…"}</p>
      ) : occ.summary_state === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-crit">Summary failed · {label} to retry</p>
          {button}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {occ.summary_state === "not_started" && <p className="text-sm text-text2">{occ.summary_note ?? "Summary not started"}</p>}
          {button || (occ.summary_state === "none" && <p className="text-sm text-text2">No summary</p>)}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function Recorded({ occ }: { occ: Occurrence }) {
  return (
    <section data-testid="occurrence-notes" className="rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <h2 className="mb-1 font-display text-[17px] font-bold">{occ.status === "held" ? "Notes" : "Skipped"}</h2>
      <p className="text-[15px] whitespace-pre-wrap">{(occ.status === "held" ? occ.notes : occ.skip_reason) || "No notes"}</p>
      {occ.status === "held" && occ.decisions.length > 0 && (
        <div data-testid="occurrence-decisions" className="mt-3">
          <h3 className="mb-1 text-sm font-semibold text-text2">Decisions</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {occ.decisions.map((d) => (
              <li key={d.id}>
                <Link href={d.href} className="text-accent-ink hover:underline">
                  D-{d.number} {d.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** After the meeting, the owner: notes, Record decision, Mark held or Skip (with a reason). */
function RecordForm({ occ, onChanged }: { occ: Occurrence; onChanged: () => Promise<void> }) {
  const [notes, setNotes] = useState(occ.notes ?? "");
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = { params: { path: { occurrence_id: occ.id } } };
  async function record(call: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await call();
      invalidateWaiting();
      await onChanged();
      waitingChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Record the meeting" className="rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
        Notes
        <textarea className={`${INPUT} min-h-32`} maxLength={NOTES_MAX} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {skipping && (
        <label className="mt-2 flex flex-col gap-1 text-sm font-semibold text-text2">
          Why it was skipped
          <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="solid"
          disabled={busy}
          onClick={() => record(() => unwrap(api.POST("/v1/ritual-occurrences/{occurrence_id}/held", { ...path, body: { notes, decision_ids: occ.decision_ids } })))}
        >
          Mark held
        </Button>
        {skipping ? (
          <Button
            disabled={busy || !reason.trim()}
            onClick={() => record(() => unwrap(api.POST("/v1/ritual-occurrences/{occurrence_id}/skip", { ...path, body: { reason: reason.trim() } })))}
          >
            Skip with this reason
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => setSkipping(true)}>
            Skip
          </Button>
        )}
        <LinkButton href={`/company/decisions?propose=1&subject=ritual_occurrence:${occ.id}&ref=${encodeURIComponent(occ.title)}`}>Record decision</LinkButton>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}
