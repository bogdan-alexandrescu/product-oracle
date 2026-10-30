"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Button, Chip, InfoTip, Label, Notice, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDay, zoneName } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";

import { HealthChip, HORIZON_LABEL, periodEnd, periodStart, slackText, zoneMoment, type Report, type ReportTrack } from "./_lib";

const path = (id: string) => ({ params: { path: { report_id: id } } });

// Item and track links open the Plan (/plan?item=<prd>:<key>), F1's screen: not prefetched.

/**
 * One alignment report (F6 §3), in B1's split layout: the headline and the summary figures
 * in a row, one panel per track (health worst first), and a rail with the Slack post and
 * Previous / Next report. Opening it marks it read (Done in my Inbox). The print stylesheet
 * drops the rail; on a phone the panels stack.
 */
export function ReportDetail({ id }: { id: string }) {
  const q = useQuery(`alignment-report|${id}`, () => unwrap(api.GET("/v1/alignment-reports/{report_id}", path(id))));
  const listQ = useQuery("alignment-reports|all", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 200 } } })));
  const report = q.data;
  const unread = report != null && !report.read;

  useEffect(() => {
    if (!unread) return;
    void unwrap(api.POST("/v1/alignment-reports/{report_id}/read", path(id)))
      .then(() => {
        invalidateWaiting();
        waitingChanged();
      })
      .catch(() => undefined);
  }, [id, unread]);

  const list = listQ.data ?? [];
  const at = list.findIndex((r) => r.id === id);
  const newer = at > 0 ? list[at - 1] : null;
  const older = at >= 0 && at < list.length - 1 ? list[at + 1] : null;

  return (
    <Page>
      <PageHeader
        title={report?.title ?? "Alignment report"}
        // qa-plan-11: no back link above the title: the Reports tab below leads to every report.
        info={
          <InfoTip label="this report" align="start" side="bottom">
            How each track stood against its milestones over the week. Every report is under the Reports tab.
          </InfoTip>
        }
        status={report && <Chip kind="line">{report.kind === "weekly" ? "Weekly" : "On demand"}</Chip>}
      />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !report && <Loading />}
      {report && (
        <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4 max-[1100px]:grid-cols-1 max-[600px]:gap-3 print:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
            <p data-testid="report-headline" className="font-display text-xl leading-7 font-bold tracking-heading">
              {report.headline}
            </p>
            <Figures report={report} />
            {(report.unreadable_tracks ?? []).length > 0 && (
              <Notice tone="warn">
                Oracle could not read {report.unreadable_tracks!.map((t) => t.title).join(", ")} when it made this report.
              </Notice>
            )}
            {report.tracks.map((t) => (
              <TrackPanel key={t.track_id} track={t} asOfNow={report.needs_attention_as_of_now ?? true} />
            ))}
          </div>
          <aside data-testid="report-rail" className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-4 print:hidden">
            <SlackPanel report={report} onChange={q.reload} />
            {/* qa-plan-44: "Oct 26 – Oct 29, 4:09 AM", the time zone said once under it. */}
            <Panel title="Covers">
              <div className="space-y-1 px-4 py-3 text-[15px]">
                <p className="tnum" data-testid="report-covers">
                  <span className="whitespace-nowrap">{periodStart(report)}</span> –{" "}
                  <span className="whitespace-nowrap">{periodEnd(report)}</span>
                </p>
                <p className="text-sm text-text2" data-testid="report-made">
                  Made <span className="whitespace-nowrap">{zoneMoment(report.generated_at, report.timezone)}</span>
                </p>
                <p className="text-sm text-text2">Times in {zoneName(report.timezone)}</p>
              </div>
            </Panel>
            <nav aria-label="Reports" className="flex flex-wrap gap-2">
              {older && (
                <Link href={`/plan/reports/${older.id}`} className="inline-flex h-9 items-center rounded-button border border-line-strong px-3 text-sm font-semibold hover:bg-surface2">
                  Previous report
                </Link>
              )}
              {newer && (
                <Link href={`/plan/reports/${newer.id}`} className="inline-flex h-9 items-center rounded-button border border-line-strong px-3 text-sm font-semibold hover:bg-surface2">
                  Next report
                </Link>
              )}
            </nav>
          </aside>
        </div>
      )}
    </Page>
  );
}

function Figures({ report }: { report: Report }) {
  const s = report.summary;
  const items: [string, number][] = [
    ["Tracks", s.tracks],
    ["At risk", s.at_risk],
    ["Off track", s.off_track],
    ["Dates slipping", s.slips],
    ["Now items without an issue", s.untracked_now],
    ["Unplanned work", s.unplanned],
    ["Dates verified", s.dates_verified],
    ["Dates withdrawn", s.dates_withdrawn],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <dl
        aria-label="Summary"
        data-testid="report-figures"
        className="grid grid-cols-4 overflow-hidden rounded-panel border border-line bg-surface shadow-panel max-[600px]:grid-cols-2"
      >
        {items.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col-reverse justify-end border-r border-b border-line px-4 pt-3 pb-2.5 max-[600px]:px-3">
            <dt className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">{label}</dt>
            <dd className="tnum font-display text-[26px] leading-8 font-bold tracking-heading">{value}</dd>
          </div>
        ))}
      </dl>
      {/* qa-plan-56: where the items behind the totals are listed. */}
      <p data-testid="report-figures-note" className="text-sm text-text2">
        Dates slipping are listed under each track&apos;s Needs attention. Now items without an issue are among the untracked
        items in each track&apos;s Alignment.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-1 max-[600px]:grid-cols-1">
      <Label className="pt-0.5">{label}</Label>
      <div className="min-w-0 text-[15px]">{children}</div>
    </div>
  );
}

function TrackPanel({ track: t, asOfNow }: { track: ReportTrack; asOfNow: boolean }) {
  const nxt = t.next_milestone;
  const a = t.alignment;
  return (
    <Panel title={t.prd.title} tools={<HealthChip track={t} />} testId="report-track">
      <div className="space-y-3 px-4 py-3 break-words max-[600px]:px-3">
        <p className="text-[15px]">{t.headline}</p>
        <Row label="Next milestone">
          {nxt ? (
            <>
              {nxt.name}
              {nxt.date ? `, ${formatDay(nxt.date)}` : ""}{" "}
              <span className="text-text2">{nxt.date ? (nxt.verified ? "· a verified basis supports it" : "· no verified basis") : "· undated"}</span>
            </>
          ) : (
            <span className="text-text2">None</span>
          )}
        </Row>
        <Row label="Alignment">
          <span className="tnum">
            {a.aligned} aligned · {a.drift} drift · {a.untracked} untracked · {a.done} done
          </span>
        </Row>
        {/* qa-plan-43: which version is approved, and where to update the roadmap from it. */}
        {t.prd_moved && (
          <Notice tone="warn" testId="report-prd-moved">
            {t.prd_moved_to ? `v${t.prd_moved_to} of the PRD is approved` : "A newer version of the PRD is approved"} ·{" "}
            <Link href={t.link} prefetch={false} className="font-semibold text-accent-ink hover:underline">
              Update the roadmap
            </Link>
          </Notice>
        )}
        {t.needs_attention.length > 0 && (
          <section data-testid="needs-attention" aria-label="Needs attention">
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.02em] text-text2">
              Needs attention {asOfNow ? "(as of now)" : "(this week)"}
              {asOfNow && (
                <InfoTip label="needs attention" align="start">
                  Until Oracle keeps track health alerts, this lists what puts each item at risk now, not only what changed this week.
                </InfoTip>
              )}
            </h3>
            <ul className="space-y-1.5">
              {t.needs_attention.map((n, i) => (
                <li key={`${n.item_key}-${i}`} className="text-[15px]">
                  <Link href={n.link} prefetch={false} className="font-semibold text-accent-ink hover:underline">
                    {n.title}
                  </Link>{" "}
                  <span className="text-text2">· {HORIZON_LABEL[n.horizon] ?? n.horizon}</span>: {n.detail}
                </li>
              ))}
            </ul>
          </section>
        )}
        {t.drift.length > 0 && (
          <section aria-label="Drift">
            <h3 className="mb-1 text-[13px] font-semibold tracking-[0.02em] text-text2">Drift both ways</h3>
            <ul className="space-y-1.5">
              {t.drift.map((d, i) => (
                // qa-plan-45: the chip and its words on one centred line, a steady gap between them.
                <li key={`${d.kind}-${i}`} data-testid="report-drift" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
                  <Chip kind="line" className="shrink-0">
                    {d.kind === "ahead" ? "Started early" : "Not on the roadmap"}
                  </Chip>
                  <span className="min-w-0">
                    {d.link && d.title ? (
                      <>
                        <Link href={d.link} prefetch={false} className="font-semibold text-accent-ink hover:underline">
                          {d.title}
                        </Link>{" "}
                      </>
                    ) : null}
                    {d.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(t.dates.verified.length > 0 || t.dates.withdrawn.length > 0) && (
          <section aria-label="Dates">
            <h3 className="mb-1 text-[13px] font-semibold tracking-[0.02em] text-text2">Dates this week</h3>
            <ul className="space-y-1.5 text-[15px]">
              {t.dates.verified.map((d) => (
                <li key={`v-${d.reference}-${d.supports_date}`}>
                  Verified: {d.reference} supports {formatDay(d.supports_date)}
                </li>
              ))}
              {t.dates.withdrawn.map((d) => (
                <li key={`w-${d.reference}-${d.supports_date}`}>
                  Withdrawn: {d.reference} ({formatDay(d.supports_date)})
                  {d.reason ? `: ${d.reason}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-sm">
          <Link href={t.link} prefetch={false} className="font-semibold text-accent-ink hover:underline">
            Open in the Plan
          </Link>
        </p>
      </div>
    </Panel>
  );
}

function SlackPanel({ report, onChange }: { report: Report; onChange: () => Promise<void> }) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = report.slack;
  const canRetry = can("retry_alignment_report_slack") && (s.status === "failed" || s.status === "pending");
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/alignment-reports/{report_id}/slack/retry", path(report.id)));
      invalidateWaiting();
      waitingChanged();
      await onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Slack">
      <div className="space-y-2 px-4 py-3 text-[15px]">
        <p data-testid="report-slack" className={s.status === "failed" ? "text-crit" : s.status === "posted" ? "" : "text-text2"}>
          {slackText(report)}
        </p>
        {canRetry && (
          <Button disabled={busy} onClick={retry}>
            Retry
          </Button>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Panel>
  );
}
