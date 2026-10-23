"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, Chip, confirmInPage, Empty, Label, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { INTERVIEW_STATUS_KIND, INTERVIEW_STATUS_LABEL, interviewsCall, type InterviewOut } from "@/lib/api/interviews";
import { formatDate, formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

/**
 * One customer interview (C3): what it was about, the approved guide, the transcript, Oracle's
 * snapshot and the requests it created. Withdraw link: its creator or an approver, while the
 * link is open.
 */
export function InterviewDetail({ id }: { id: string }) {
  const q = useQuery(`interview:${id}`, () => interviewsCall<InterviewOut>("GET", `/v1/interviews/${encodeURIComponent(id)}`));
  const iv = q.data;
  const requests = useQuery(`interview-requests:${iv?.request_ids.join(",") ?? ""}`, () =>
    Promise.all(
      (iv?.request_ids ?? []).map((rid) =>
        unwrap(api.GET("/v1/requests/{request_id}", { params: { path: { request_id: rid } } })).catch(() => null),
      ),
    ),
  );
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    if (!iv) return;
    const yes = await confirmInPage({
      action: "Withdraw link",
      message: `Withdraw the link sent to ${iv.interviewee_name}? It stops working at once.`,
      destructive: true,
    });
    if (!yes) return;
    setError(null);
    try {
      const next = await interviewsCall<InterviewOut>("POST", `/v1/interviews/${iv.id}/revoke`);
      q.setData(() => next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const back = (
    <Link href="/requests/interviews" className="font-semibold text-accent-ink hover:underline">
      Interviews
    </Link>
  );
  if (!iv) {
    return (
      <Page>
        <PageHeader title="Interview" back={back} />
        {q.error ? <ErrorNote>{q.error}</ErrorNote> : <Loading />}
      </Page>
    );
  }

  const open = iv.status === "invited" || iv.status === "in_progress";
  const who = iv.interviewee_company ? `${iv.interviewee_name} · ${iv.interviewee_company}` : (iv.interviewee_name ?? "Interview");
  const prompt = (item: string | null) => iv.guide.find((g) => g.id === item)?.prompt ?? null;
  const snap = iv.snapshot ?? {};
  const facts = snap.quick_facts ?? [];
  const quotes = snap.quotes ?? [];
  const needs = snap.needs ?? [];
  const insights = snap.insights ?? [];
  const hasSnapshot = facts.length + quotes.length + needs.length + insights.length > 0;
  const transcript = iv.messages.filter((m) => m.kind !== "intro");

  return (
    <Page>
      <PageHeader
        title={who}
        back={back}
        status={
          <Chip kind={INTERVIEW_STATUS_KIND[iv.status]} dot data-testid="interview-status">
            {INTERVIEW_STATUS_LABEL[iv.status]}
          </Chip>
        }
        action={
          iv.can_manage &&
          open && (
            <Button variant="danger" onClick={withdraw}>
              Withdraw link
            </Button>
          )
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        <Panel title="About">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-[15px]">
            <Fact label="What it was about">{iv.title}</Fact>
            <Fact label="Created by">
              {iv.created_by_name ?? "—"} · {formatDate(iv.created_at)}
            </Fact>
            {iv.link_expires_at && open && <Fact label="Link expires">{formatDateTime(iv.link_expires_at)}</Fact>}
            {iv.finished_at && <Fact label="Finished">{formatDateTime(iv.finished_at)}</Fact>}
          </dl>
        </Panel>

        <Panel title="Questions" count={iv.guide.length} testId="interview-guide">
          {iv.intro && <p className="px-4 pt-3 text-[15px] text-text2">{iv.intro}</p>}
          {iv.guide.length ? (
            <ol className="flex list-decimal flex-col gap-2 py-3 pr-4 pl-9 text-[15px]">
              {iv.guide.map((g) => (
                <li key={g.id}>
                  {g.prompt}
                  {g.purpose && <span className="block text-sm text-text2">{g.purpose}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No questions yet</Empty>
          )}
        </Panel>

        <Panel title="Transcript" testId="interview-transcript">
          {transcript.length ? (
            <ol className="flex flex-col gap-3 px-4 py-3">
              {transcript.map((m) => (
                <li key={m.id} data-testid={`transcript-${m.role}`} className="flex min-w-0 flex-col gap-0.5">
                  <Label>{m.role === "oracle" ? "Oracle" : iv.interviewee_name}</Label>
                  {m.kind === "skip" ? (
                    <p className="text-[15px] text-text2 italic">Skipped: {prompt(m.guide_item) ?? "this question"}</p>
                  ) : (
                    <p className="text-[15px] break-words whitespace-pre-wrap">{m.body}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Nothing said yet</Empty>
          )}
        </Panel>

        <Panel title="Snapshot" testId="interview-snapshot">
          {hasSnapshot ? (
            <div className="flex flex-col gap-4 px-4 py-3 text-[15px]">
              {facts.length > 0 && (
                <Part title="Quick facts">
                  <ul className="list-disc pl-5">
                    {facts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </Part>
              )}
              {quotes.length > 0 && (
                <Part title="Quotes">
                  {quotes.map((x, i) => (
                    <blockquote key={i} className="border-l-2 border-line-strong pl-3 break-words">
                      &ldquo;{x.text}&rdquo;
                    </blockquote>
                  ))}
                </Part>
              )}
              {needs.length > 0 && (
                <Part title="Needs">
                  <ul className="flex flex-col gap-1.5">
                    {needs.map((n, i) => (
                      <li key={i} data-testid="snapshot-need">
                        <span className="font-semibold">{n.title}</span>
                        <span className="block text-sm break-words text-text2">&ldquo;{n.quote}&rdquo;</span>
                      </li>
                    ))}
                  </ul>
                </Part>
              )}
              {insights.length > 0 && (
                <Part title="Insights">
                  <ul className="list-disc pl-5">
                    {insights.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </Part>
              )}
            </div>
          ) : (
            <Empty>{iv.status === "finished" ? "Oracle is writing the snapshot" : "No snapshot yet"}</Empty>
          )}
        </Panel>

        <Panel title="Requests created" count={iv.request_ids.length} testId="interview-requests">
          {iv.request_ids.length ? (
            <ul className="flex flex-col gap-1.5 px-4 py-3 text-[15px]">
              {iv.request_ids.map((rid, i) => (
                <li key={rid}>
                  <Link href={`/requests/new#request-${rid}`} className="font-semibold text-accent-ink hover:underline">
                    {requests.data?.[i]?.title ?? "Request"}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>None yet</Empty>
          )}
        </Panel>
      </div>
    </Page>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm font-semibold text-text2">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-display text-base font-bold tracking-heading">{title}</h3>
      {children}
    </section>
  );
}
