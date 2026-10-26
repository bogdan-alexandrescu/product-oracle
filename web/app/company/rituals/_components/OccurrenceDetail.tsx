"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { FindingCard } from "@/app/company/market/_components/FindingCard";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button, Chip, LinkButton, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { parseBlocks } from "@/lib/markdown";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { STATE_KIND, STATE_LABEL, localTime, zoneTime, type Occurrence } from "./lib";
import { MetricsTable, VarianceCards, type MetricRow, type VarianceRow } from "./MetricBlocks";

/** H5: the blocks drawn as their own cards across the page (the metrics review). */
const WIDE = new Set(["metrics_table", "variances"]);

type Row = { text?: string; href?: string | null; method?: string; label?: string; finding_id?: string; summary?: string | null; untrusted?: boolean };

/** A row's text, with an untrusted summary (H7: a promoted web finding's title, kept out of the pre-read's text) shown as plain text. */
const rowText = (r: Row) => (r.untrusted && r.summary ? `${r.text} · ${r.summary}` : r.text);
type Block = { key: string; title: string; as_of?: string; rows: Row[] };

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
        {occ.kind === "baseline_rebuild" ? (
          <RebuildCard occ={occ} blocks={blocks} canBuild={can("confirm_entity")} />
        ) : (
          <SummaryCard
            occ={occ}
            canAsk={can("summarize_ritual_occurrence") && (occ.kind !== "metrics_review" || openVariances(blocks, live) > 0)}
            onChanged={reload}
          />
        )}
        {blocks.length === 0 ? (
          <Panel title="Pre-read">
            <p className="px-4 py-3 text-sm text-text2">The pre-read is not ready yet</p>
          </Panel>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
            {blocks.map((b) =>
              b.key === "competitor_web" ? (
                <WebFindingsCard key={b.key} block={b} occurrenceId={occ.id} canDecide={can("promote_web_finding")} />
              ) : (
                <BlockCard key={b.key} block={b} live={live} onChanged={varianceQ.reload} />
              ),
            )}
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
                  {rowText(r)}
                </Link>
              ) : (
                rowText(r)
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * H7: a competitive digest's From the web card. The findings the digest run made, live (a
 * promoted or dismissed one shows its state; a dismissed one is gone on the next read), each
 * Not vetted with its host and date, and Promote and Dismiss for approvers and owners. Rows
 * without a finding ("Web search is not set up") show as text.
 */
function WebFindingsCard({ block, occurrenceId, canDecide }: { block: Block; occurrenceId: string; canDecide: boolean }) {
  const q = useQuery(`occurrence-web-findings|${occurrenceId}`, async () => {
    const [open, promoted] = await Promise.all(
      (["open", "promoted"] as const).map((status) =>
        unwrap(api.GET("/v1/competitor-web-findings", { params: { query: { status, occurrence_id: occurrenceId, include_older: true } } })),
      ),
    );
    return [...open, ...promoted];
  });
  const notes = block.rows.filter((r) => !r.finding_id);
  const findings = q.data ?? [];
  return (
    <section data-testid="ritual-block" data-key={block.key} className="min-w-0 rounded-panel border border-line bg-surface shadow-panel">
      <header className="border-b border-line px-4 py-2.5">
        <h2 className="font-display text-[17px] font-bold">{block.title}</h2>
        {block.as_of && <p className="text-[13px] text-text2">Data as of {localTime(block.as_of)}</p>}
      </header>
      <div className="flex flex-col divide-y divide-line px-4">
        {q.error && <ErrorNote>{q.error}</ErrorNote>}
        {q.data && findings.length === 0 && notes.length === 0 && <p className="py-3 text-sm text-text2">Nothing this time</p>}
        {notes.map((r, i) => (
          <p key={i} className="py-3 text-sm text-text2">
            {r.text}
          </p>
        ))}
        {findings.map((f) => (
          <FindingCard key={f.id} finding={f} canDecide={canDecide} onPromoted={() => void q.reload()} onDismissed={() => void q.reload()} />
        ))}
      </div>
    </section>
  );
}

const NO_HIGHLIGHTS: never[] = [];
const NO_CITATIONS = new Map();

/**
 * Oracle's summary: written, being written, failed or not started, or Summarize with Oracle.
 * Every kind's summary is Markdown, drawn with MarkdownBody (#556).
 * A competitive digest's is the digest (H7): Markdown the importer cleaned (no raw HTML, links
 * only to Oracle pages and this run's recorded results), written with "Write the digest with
 * Oracle". A metrics review's is Explain with Oracle (H5: its own run drafts each variance's
 * explanation); with no open variance the button is absent.
 */
function SummaryCard({ occ, canAsk, onChanged }: { occ: Occurrence; canAsk: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digest = occ.kind === "competitive_digest";
  // H5: a metrics review's summary is Explain with Oracle (its own run drafts each variance's explanation).
  const metrics = occ.kind === "metrics_review";
  const words = digest
    ? { title: "Digest", ask: "Write the digest with Oracle", running: "Writing the digest…", failed: "Digest failed · Write the digest with Oracle to retry", none: "No digest" }
    : metrics
      ? { title: "Summary", ask: "Explain with Oracle", running: "Writing…", failed: "Summary failed · Explain with Oracle to retry", none: "No summary" }
      : { title: "Summary", ask: "Summarize with Oracle", running: "Writing the summary…", failed: "Summary failed · Summarize with Oracle to retry", none: "No summary" };
  // #556: every kind's summary is Markdown; it renders as the digest's does (links only where isSafeHref allows).
  const body = useMemo(() => (occ.summary ? parseBlocks(occ.summary) : null), [occ.summary]);
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
  // Not offered when Oracle does not write it (a digest at H11 "Watch the market" Observe).
  const button = canAsk && occ.pre_read.built_at && occ.summary_offered !== false && (
    <Button variant="solid" disabled={busy} onClick={ask}>
      {words.ask}
    </Button>
  );
  return (
    <section data-testid="occurrence-summary" className="rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <h2 className="mb-1 font-display text-[17px] font-bold">{words.title}</h2>
      {occ.summary_state === "ready" && occ.summary ? (
        <>
          <div className="doc-body min-w-0 [overflow-wrap:anywhere]">
            <MarkdownBody blocks={body ?? []} highlights={NO_HIGHLIGHTS} activeId={null} citations={NO_CITATIONS} onHighlightClick={() => {}} />
          </div>
          <p className="mt-1 text-[13px] text-text2">Written by Oracle</p>
        </>
      ) : occ.summary_state === "running" ? (
        <p className="text-sm text-text2">{words.running}</p>
      ) : occ.summary_state === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-crit">{words.failed}</p>
          {button}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {occ.summary_state === "not_started" && <p className="text-sm text-text2">{occ.summary_note ?? `${words.title} not started`}</p>}
          {button || (occ.summary_state === "none" && <p className="text-sm text-text2">{words.none}</p>)}
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

/**
 * The Baseline rebuild's build (oracle.rituals.rebuild): B1's Build the baseline run Oracle
 * started with its estimate (over $50 it says it waits for an owner's approval, P3), or why it
 * started none (Observe, a build under way) with B1's sheet one click away. Its proposals are reviewed as B1's are.
 */
function RebuildCard({ occ, blocks, canBuild }: { occ: Occurrence; blocks: Block[]; canBuild: boolean }) {
  const estimate = blocks.flatMap((b) => b.rows.map((r) => r.text ?? "")).find((t) => t.startsWith("Estimate "));
  const run = occ.summary_run_id ? `/runs/${occ.summary_run_id}` : null;
  const build = canBuild && <LinkButton href="/baseline?build=1">Build the baseline</LinkButton>;
  return (
    <section data-testid="occurrence-rebuild" className="rounded-panel border border-line bg-surface px-4 py-3 shadow-panel">
      <h2 className="mb-1 font-display text-[17px] font-bold">Baseline build</h2>
      {occ.summary_state === "running" && run ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">
            Oracle started the baseline build{estimate ? ` · ${estimate}` : ""}. {occ.summary_note ?? "Its proposals wait for your review."}
          </p>
          <LinkButton href={run}>Open run</LinkButton>
        </div>
      ) : occ.summary_state === "ready" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">The build finished. Its proposals are on the Baseline page.</p>
          <LinkButton href="/baseline">Open baseline</LinkButton>
        </div>
      ) : occ.summary_state === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-crit">{occ.summary_note ?? "The baseline build did not finish"}</p>
          {run && <LinkButton href={run}>Open run</LinkButton>}
          {build}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-text2">{occ.summary_note ?? "Oracle starts the build when the rebuild falls due."}</p>
          {occ.summary_state === "not_started" && build}
        </div>
      )}
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
