"use client";

import { useState } from "react";

import { Chip, Empty, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import type { InboxOut } from "../runs/_lib";
import { CountChip, inboxNeeds, NeedTable, type Act } from "./_needs";

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

  return (
    <Page>
      <PageHeader title="Inbox" status={inbox && inbox.total > 0 && <Chip kind="acc">{inbox.total} waiting</Chip>} />
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !inbox && <Loading />}
      {error && (
        <div className="mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {inbox && <Needs inbox={inbox} busy={busy} act={act} />}
    </Page>
  );
}

function Needs({ inbox, busy, act }: { inbox: InboxOut; busy: string | null; act: Act }) {
  const { checkpoints, approvals, overruns, feedback } = inboxNeeds(inbox, busy, act);

  return (
    <Panel
      title="Needs you"
      count={inbox.total}
      tools={
        inbox.total > 0 && (
          <>
            {checkpoints.length > 0 && <CountChip label="Checkpoints" n={checkpoints.length} />}
            {approvals.length + overruns.length > 0 && <CountChip label="Cost" n={approvals.length + overruns.length} />}
            {feedback.length > 0 && <CountChip label="Feedback" n={feedback.length} />}
          </>
        )
      }
    >
      {inbox.total === 0 ? (
        <Empty>
          Nothing waiting{" "}
          <InfoTip label="the inbox" align="start">
            Checkpoints that need a decision, such as a run waiting for budget approval or a draft ready for review, land
            here.
          </InfoTip>
        </Empty>
      ) : (
        <>
          <NeedTable title="Checkpoints" testId="inbox-checkpoints" rows={checkpoints} />
          <NeedTable title="Cost approvals" testId="inbox-approvals" rows={approvals} />
          <NeedTable title="Paused on overrun" testId="inbox-overruns" rows={overruns} />
          <NeedTable title="Open feedback" testId="inbox-feedback" rows={feedback} />
        </>
      )}
    </Panel>
  );
}
