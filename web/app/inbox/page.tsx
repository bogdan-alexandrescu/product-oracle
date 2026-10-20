"use client";

import { useState } from "react";

import { Chip, Empty, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type DocumentSummary, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, waitingChanged } from "@/lib/waiting";

import type { InboxOut } from "../runs/_lib";
import { CountChip, inboxNeeds, NeedTable, questionNeeds, type Act } from "./_needs";

type Question = Schemas["StakeholderQuestionOut"];

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
  const { checkpoints, approvals, overruns, lookups, imports, searches, feedback, revokeFailures } = inboxNeeds(
    inbox,
    busy,
    act,
  );
  const asked = questionNeeds(questions, docs);
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
            {revokeFailures.length > 0 && <CountChip label="Access" n={revokeFailures.length} />}
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
          <NeedTable title="Couldn't revoke access" testId="inbox-revoke-failures" rows={revokeFailures} />
          <NeedTable title="Looking for earlier submissions" testId="inbox-searches" rows={searches} />
          <NeedTable title="Open feedback" testId="inbox-feedback" rows={feedback} />
          <NeedTable title="Questions" testId="inbox-questions" rows={asked} />
        </>
      )}
    </Panel>
  );
}
