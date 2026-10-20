"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CHECKPOINT_LABEL, usd, type RunSummary } from "../runs/_lib";

/** Why the last attempt did not revoke, in the owner's words. */
function revokeOutcome(outcome: string | null | undefined, provider: string): string {
  if (outcome === "not_configured") return `Oracle's ${provider} sign-in app is not configured`;
  if (outcome === "unreadable") return "Oracle could not read its copy of the credential";
  return `${provider} refused or did not answer`;
}

function Section({ title, count, children, testId }: { title: string; count: number; children: ReactNode; testId: string }) {
  if (count === 0) return null;
  return (
    <section className="mb-8" aria-label={title} data-testid={testId}>
      <h2 className="mb-3 text-sm font-semibold text-neutral-700">
        {title} <span className="font-normal text-neutral-400">{count}</span>
      </h2>
      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">{children}</ul>
    </section>
  );
}

function RunLink({ run }: { run: Pick<RunSummary, "id" | "flow_title" | "document_slug"> }) {
  return (
    <Link href={`/runs/${run.id}`} className="font-medium text-neutral-900 hover:underline">
      {run.flow_title}
      {run.document_slug && <span className="ml-1.5 font-mono text-xs font-normal text-neutral-500">{run.document_slug}</span>}
    </Link>
  );
}

export default function InboxPage() {
  const q = useQuery("inbox", () => unwrap(api.GET("/v1/inbox")));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inbox = q.data;

  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await call();
      await q.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const path = (id: string) => ({ params: { path: { run_id: id } } });

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-neutral-900">Inbox</h1>
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
      {inbox && inbox.total === 0 && (
        <div className="space-y-2 text-neutral-600">
          <p>
            Nothing waiting on you. Checkpoints that need a decision, such as a run waiting for budget approval or a
            draft ready for review, land here.
          </p>
          <p>You will see each item with what it needs from you and a link to act on it.</p>
        </div>
      )}
      {inbox && (
        <>
          <Section title="Checkpoints" count={inbox.checkpoints.length} testId="inbox-checkpoints">
            {inbox.checkpoints.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-neutral-900">{CHECKPOINT_LABEL[c.kind]}</div>
                  <div className="text-xs text-neutral-500">
                    {c.flow_title}
                    {c.segment_title && ` · ${c.segment_title}`}
                    {c.document_slug && ` · ${c.document_slug}`} · {formatDateTime(c.created_at)}
                  </div>
                </div>
                <Link
                  href={`/runs/${c.run_id}`}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
                >
                  Review
                </Link>
              </li>
            ))}
          </Section>

          <Section title="Cost approvals" count={inbox.approvals.length} testId="inbox-approvals">
            {inbox.approvals.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <RunLink run={r} />
                  <div className="text-xs text-neutral-500">Estimated {usd(r.estimate_usd)}, over the $50 approval threshold</div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act(`approve-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/approve", path(r.id))))}
                >
                  Approve {usd(r.estimate_usd)}
                </Button>
              </li>
            ))}
          </Section>

          <Section title="Paused on overrun" count={inbox.overruns.length} testId="inbox-overruns">
            {inbox.overruns.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <RunLink run={r} />
                  <div className="text-xs text-neutral-500">
                    Spent {usd(r.spent_usd)} of {usd(r.estimate_usd)} estimated
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => act(`resume-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/resume", path(r.id))))}
                >
                  Resume
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act(`cancel-${r.id}`, () => unwrap(api.POST("/v1/runs/{run_id}/cancel", path(r.id))))}
                >
                  Cancel run
                </Button>
              </li>
            ))}
          </Section>

          <Section
            title="Couldn't revoke access"
            count={inbox.revoke_failures?.length ?? 0}
            testId="inbox-revoke-failures"
          >
            {(inbox.revoke_failures ?? []).map((f) => {
              const provider = f.provider_name ?? f.provider ?? "the provider";
              return (
                <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="revoke-failure">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-neutral-900">{f.title}</div>
                    <div className="text-xs text-neutral-500">
                      {revokeOutcome(f.outcome, provider)}
                      {f.last_error && ` (${f.last_error})`} · tried {f.attempts} time{f.attempts === 1 ? "" : "s"} ·{" "}
                      {f.status === "pending"
                        ? `retrying until ${formatDateTime(f.retry_until)}`
                        : `stopped retrying ${formatDateTime(f.retry_until)}`}
                    </div>
                    <div className="text-xs text-neutral-500">
                      Oracle keeps a copy of the credential until the revoke succeeds or you dismiss this. Dismiss if you
                      revoked the access at {provider} yourself.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() =>
                      act(`retry-${f.id}`, () =>
                        unwrap(
                          api.POST("/v1/member-follow-ups/{follow_up_id}/retry", {
                            params: { path: { follow_up_id: f.id } },
                          }),
                        ),
                      )
                    }
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(`dismiss-${f.id}`, () =>
                        unwrap(
                          api.POST("/v1/member-follow-ups/{follow_up_id}/dismiss", {
                            params: { path: { follow_up_id: f.id } },
                          }),
                        ),
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </li>
              );
            })}
          </Section>

          <Section title="Open feedback" count={inbox.feedback.length} testId="inbox-feedback">
            {inbox.feedback.map((d) => (
              <li key={d.document_id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    href={d.latest_version ? `/documents/${d.slug}/v/${d.latest_version}` : `/documents/${d.slug}`}
                    className="font-medium text-neutral-900 hover:underline"
                  >
                    {d.title}
                  </Link>
                  <span className="text-xs text-neutral-500">
                    {d.open_count} open item{d.open_count === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-0.5 text-neutral-600">
                  {d.items.map((f) => (
                    <li key={f.id} className="truncate">
                      <span className="text-xs text-neutral-400">v{f.raised_on_version} · </span>
                      {f.summary}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
