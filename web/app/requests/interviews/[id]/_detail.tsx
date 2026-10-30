"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, Chip, confirmInPage, Dialog, Empty, Label, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { INTERVIEW_STATUS_KIND, INTERVIEW_STATUS_LABEL, interviewsCall, type InterviewLink, type InterviewOut } from "@/lib/api/interviews";
import { formatDateTime, formatDay } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { expiresIn, LinkShown } from "../../_components/InterviewDialog";

/**
 * One customer interview (C3): what it was about, the approved guide, the transcript, Oracle's
 * snapshot and the requests it created. Withdraw link: its creator or an approver, while the
 * link is open. "← Interviews" above the name is the one way back (rirs-40, qa-work-44: the
 * Requests tabs are not drawn here).
 * The link itself is shown once, when it is made, and only its hash is kept, so it cannot be
 * shown or copied again here (qa-work-43): the page says so and when it was made, and Make a
 * new link (its creator or an approver, while the link is open) shows a fresh one once, after
 * asking; the old link then tells whoever opens it that it was replaced.
 * An empty section says why it is empty and what comes next (qa-work-44).
 */
export function InterviewDetail({ id }: { id: string }) {
  const q = useQuery(`interview:${id}`, () => interviewsCall<InterviewOut>("GET", `/v1/interviews/${encodeURIComponent(id)}`));
  const iv = q.data;
  // rirs-40: back to the Interviews tab, above the name.
  const back = (
    <Link href="/requests/interviews" data-testid="interview-back" className="hover:underline">
      ← Interviews
    </Link>
  );
  const requests = useQuery(`interview-requests:${iv?.request_ids.join(",") ?? ""}`, () =>
    Promise.all(
      (iv?.request_ids ?? []).map((rid) =>
        unwrap(api.GET("/v1/requests/{request_id}", { params: { path: { request_id: rid } } })).catch(() => null),
      ),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [newLink, setNewLink] = useState(false);

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

  if (!iv) {
    return (
      <Page>
        <PageHeader back={back} title="Interview" />
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
  const name = iv.interviewee_name ?? "The customer";
  const finished = iv.status === "finished";

  return (
    <Page>
      <PageHeader
        back={back}
        title={who}
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
      {newLink && <NewLinkDialog interview={iv} onMade={(next) => q.setData(() => next)} onClose={() => setNewLink(false)} />}
      <div className="flex min-w-0 flex-col gap-4 max-[600px]:gap-3">
        <Panel title="About" testId="interview-about">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-[15px]">
            <Fact label="What it was about">{iv.title}</Fact>
            <Fact label="Created by">
              {iv.created_by_name ?? "—"}
              {/* qa-work-44: one date: the link's, when it shows, else the day it was made. */}
              {!(iv.link_created_at && open) && ` · ${formatDay(iv.created_at)}`}
            </Fact>
            {iv.link_created_at && open && (
              <Fact label="Link made">
                <span data-testid="interview-link-made">{formatDateTime(iv.link_created_at)}</span>
              </Fact>
            )}
            {iv.link_expires_at && open && (
              <Fact label="Link expires">
                <span data-testid="interview-link-expires">{expiresIn(iv.link_expires_at)}</span>
              </Fact>
            )}
            {iv.finished_at && <Fact label="Finished">{formatDateTime(iv.finished_at)}</Fact>}
            {open && (
              <Fact label="Link">
                <span data-testid="interview-link-note">
                  {iv.link_opened_at ? `Opened ${formatDateTime(iv.link_opened_at)}. ` : "Not opened yet. "}
                  For safety the link is shown only once, when it is made, so it can&apos;t be shown or copied again.
                  {iv.can_manage && ` If ${name} lost it, use Make a new link; the old link stops working.`}
                </span>
                {iv.can_manage && (
                  <div className="mt-2">
                    <Button variant="secondary" onClick={() => setNewLink(true)}>
                      Make a new link
                    </Button>
                  </div>
                )}
              </Fact>
            )}
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
            <Empty testId="interview-transcript-empty">{transcriptEmpty(iv, name)}</Empty>
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
            <Empty testId="interview-snapshot-empty">
              {finished ? "Oracle is writing the snapshot" : `Oracle writes a snapshot here once ${name} finishes the interview.`}
            </Empty>
          )}
        </Panel>

        <Panel title="Requests created" count={iv.request_ids.length} testId="interview-requests">
          {iv.request_ids.length ? (
            <ul className="flex flex-col gap-1.5 px-4 py-3 text-[15px]">
              {iv.request_ids.map((rid, i) => (
                <li key={rid}>
                  <Link href={`/requests?request=${encodeURIComponent(rid)}`} className="font-semibold text-accent-ink hover:underline">
                    {requests.data?.[i]?.title ?? "Request"}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty testId="interview-requests-empty">
              {finished
                ? `Oracle found no requests in what ${name} said.`
                : `The requests ${name} makes show here, to decide, once they finish the interview.`}
            </Empty>
          )}
        </Panel>
      </div>
    </Page>
  );
}

/** Why the transcript is empty, and what to do (qa-work-44). */
function transcriptEmpty(iv: InterviewOut, name: string): string {
  switch (iv.status) {
    case "draft":
      return "No link has been made yet, so nobody has been asked.";
    case "invited":
      return iv.link_opened_at
        ? `${name} opened the link but hasn't answered yet.`
        : `${name} hasn't opened the link yet. Send it to them if you haven't.`;
    case "in_progress":
      return `${name} has started but hasn't answered yet.`;
    case "expired":
      return `The link expired before ${name} answered. Interview them again for a new link.`;
    case "revoked":
      return `The link was withdrawn before ${name} answered.`;
    default:
      return `${name} finished without answering.`;
  }
}

/**
 * Make a new link (qa-work-43): asks first, then shows the new link once with Copy, as when the
 * interview was first made. The interview is read again so the page shows when it was made.
 */
function NewLinkDialog({ interview, onMade, onClose }: { interview: InterviewOut; onMade: (next: InterviewOut) => void; onClose: () => void }) {
  const [link, setLink] = useState<InterviewLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const made = await interviewsCall<InterviewLink>("POST", `/v1/interviews/${interview.id}/new-link`);
      setLink(made);
      onMade(await interviewsCall<InterviewOut>("GET", `/v1/interviews/${interview.id}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (link) {
    return (
      <Dialog title="New link made" onClose={onClose} testId="new-link-dialog">
        <LinkShown link={link} />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="Make a new link"
      onClose={onClose}
      testId="new-link-dialog"
      actions={
        <Button variant="primary" onClick={make} disabled={busy}>
          Make a new link
        </Button>
      }
    >
      <p>Make a new link? The old link stops working.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Dialog>
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
