"use client";

import { useState } from "react";

import { Button, Chip, Empty, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, waitingChanged } from "@/lib/waiting";

import type { InboxOut } from "../runs/_lib";
import { CountChip, inboxNeeds, NeedTable, questionNeeds, type Act, type Need } from "./_needs";

type Question = Schemas["StakeholderQuestionOut"];
type RevokeFailure = NonNullable<InboxOut["revoke_failures"]>[number];

/** Why the last attempt did not revoke, in the owner's words. */
function revokeOutcome(outcome: string | null | undefined, provider: string): string {
  if (outcome === "not_configured") return `Oracle's ${provider} sign-in app is not configured`;
  if (outcome === "unreadable") return "Oracle could not read its copy of the credential";
  return `${provider} refused or did not answer`;
}

/** Owners only: a provider revoke a removed member's disable could not make, with Retry and Dismiss. */
function revokeNeeds(failures: RevokeFailure[], busy: string | null, act: Act): Need[] {
  return failures.map((f) => {
    const provider = f.provider_name ?? f.provider ?? "the provider";
    const why = [
      `${revokeOutcome(f.outcome, provider)}${f.last_error ? ` (${f.last_error})` : ""}`,
      `tried ${f.attempts} time${f.attempts === 1 ? "" : "s"}`,
      f.status === "pending"
        ? `retrying until ${formatDateTime(f.retry_until)}`
        : `stopped retrying ${formatDateTime(f.retry_until)}`,
    ].join(" · ");
    const path = { params: { path: { follow_up_id: f.id } } };
    return {
      key: f.id,
      icon: "lock",
      kind: "Couldn't revoke",
      item: (
        <>
          <span className="truncate" title={f.title}>
            {f.title}
          </span>
          <InfoTip label="this revoke" align="start">
            Oracle keeps a copy of the credential until the revoke succeeds or you dismiss this. Dismiss if you revoked
            the access at {provider} yourself.
          </InfoTip>
        </>
      ),
      context: (
        <span className="block truncate text-text2" title={why}>
          {why}
        </span>
      ),
      at: f.created_at,
      action: (
        <>
          <Button
            disabled={busy !== null}
            onClick={() =>
              act(`retry-${f.id}`, () => unwrap(api.POST("/v1/member-follow-ups/{follow_up_id}/retry", path)))
            }
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() =>
              act(`dismiss-${f.id}`, () => unwrap(api.POST("/v1/member-follow-ups/{follow_up_id}/dismiss", path)))
            }
          >
            Dismiss
          </Button>
        </>
      ),
    };
  });
}

export default function InboxPage() {
  const q = useQuery("inbox", loadInbox);
  // Questions asked of me (I3): their own group, counted with the rest as the rail badge counts.
  const questionsQ = useQuery("inbox|questions", loadMyQuestions);
  const docsQ = useQuery("inbox|documents", () => unwrap(api.GET("/v1/documents")));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inbox = q.data;
  const questions = questionsQ.data ?? [];
  const waiting = inbox ? inbox.total + questions.length : undefined;

  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await call();
      invalidateWaiting();
      const reloads = Promise.all([q.reload(), questionsQ.reload()]);
      waitingChanged();
      await reloads;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page>
      <PageHeader title="Inbox" status={waiting != null && waiting > 0 && <Chip kind="acc">{waiting} waiting</Chip>} />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !inbox && <Loading />}
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {inbox && (
        <Needs
          inbox={inbox}
          questions={questions}
          questionsError={questionsQ.error}
          docs={docsQ.data ?? []}
          busy={busy}
          act={act}
        />
      )}
    </Page>
  );
}

function Needs({
  inbox,
  questions,
  questionsError,
  docs,
  busy,
  act,
}: {
  inbox: InboxOut;
  questions: Question[];
  questionsError: string | null;
  docs: DocumentSummary[];
  busy: string | null;
  act: Act;
}) {
  const { checkpoints, approvals, overruns, lookups, imports, searches, feedback } = inboxNeeds(inbox, busy, act);
  const asked = questionNeeds(questions, docs);
  const revokes = revokeNeeds(inbox.revoke_failures ?? [], busy, act);
  const total = inbox.total + asked.length;

  return (
    <Panel
      title="Needs you"
      count={total}
      tools={
        total > 0 && (
          <>
            {checkpoints.length > 0 && <CountChip label="Checkpoints" n={checkpoints.length} />}
            {approvals.length + overruns.length > 0 && <CountChip label="Cost" n={approvals.length + overruns.length} />}
            {lookups.length + imports.length > 0 && <CountChip label="Runs" n={lookups.length + imports.length} />}
            {revokes.length > 0 && <CountChip label="Access" n={revokes.length} />}
            {feedback.length > 0 && <CountChip label="Feedback" n={feedback.length} />}
            {asked.length > 0 && <CountChip label="Questions" n={asked.length} />}
          </>
        )
      }
    >
      {questionsError && (
        <div className="px-4 pt-3" data-testid="inbox-questions-error">
          <ErrorNote>{questionsError}</ErrorNote>
        </div>
      )}
      {total === 0 && searches.length === 0 ? (
        !questionsError && (
          <Empty>
            Nothing waiting{" "}
            <InfoTip label="the inbox" align="start">
              Checkpoints that need a decision, such as a run waiting for budget approval or a draft ready for review, land
              here, with the questions asked of you.
            </InfoTip>
          </Empty>
        )
      ) : (
        <>
          <NeedTable title="Checkpoints" testId="inbox-checkpoints" rows={checkpoints} />
          <NeedTable title="Cost approvals" testId="inbox-approvals" rows={approvals} />
          <NeedTable title="Paused on overrun" testId="inbox-overruns" rows={overruns} />
          <NeedTable title="Stuck runs" testId="inbox-lookups" rows={lookups} />
          <NeedTable title="Couldn't import" testId="inbox-imports" rows={imports} />
          <NeedTable title="Looking for earlier submissions" testId="inbox-searches" rows={searches} />
          <NeedTable title="Couldn't revoke access" testId="inbox-revoke-failures" rows={revokes} />
          <NeedTable title="Open feedback" testId="inbox-feedback" rows={feedback} />
          <NeedTable title="Questions" testId="inbox-questions" rows={asked} />
        </>
      )}
    </Panel>
  );
}
