"use client";

import { useEffect, useState } from "react";

import { Chip, Empty, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { TabBar } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, markInboxSeen, waitingChanged } from "@/lib/waiting";

import { allNeeds, NeedTable, questionNeeds, STATE_TABS, waitingNeeds, type InboxState, type NeedGroup } from "./_needs";

export default function InboxPage() {
  const q = useQuery("inbox", loadInbox);
  // Questions asked of me (I3): their own group, counted with the rest as the rail badge counts.
  const questionsQ = useQuery("inbox|questions", loadMyQuestions);
  const docsQ = useQuery("inbox|documents", () => unwrap(api.GET("/v1/documents")));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // C1e: my previous visit, read once on arrival; what was new then stays New for this visit.
  const arrivalQ = useQuery("inbox|arrival", () => loadInbox().then((d) => d.last_seen_at ?? null));
  const arrived = !arrivalQ.loading && !arrivalQ.error;
  useEffect(() => {
    // After the first render with the arrival's states: this visit becomes my last one.
    if (arrived) void markInboxSeen().catch(() => undefined);
  }, [arrived]);
  const inbox = q.data;
  const questions = questionsQ.data ?? [];

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

  const seenBefore = arrived ? arrivalQ.data : inbox?.last_seen_at;
  const rows = inbox ? allNeeds(inbox, questionNeeds(questions, docsQ.data ?? []), busy, act, seenBefore) : null;
  const waiting = rows ? waitingNeeds(rows).length : undefined;

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
      {inbox && rows && <InboxTabs rows={rows} waiting={waiting ?? 0} questionsError={questionsQ.error} />}
    </Page>
  );
}

/** The groups a tab draws, in order; each is one table under its own label. */
const GROUPS: { id: NeedGroup; title: string }[] = [
  { id: "checkpoints", title: "Checkpoints" },
  { id: "approvals", title: "Cost approvals" },
  { id: "overruns", title: "Paused on overrun" },
  { id: "lookups", title: "Stuck runs" },
  { id: "imports", title: "Couldn't import" },
  { id: "feedback", title: "Feedback" },
  { id: "questions", title: "Questions" },
  { id: "searches", title: "Looking for earlier submissions" },
];

/**
 * ONE Inbox (owner, 2026-10-20): every kind of item in a single list with state tabs, New
 * first (the default on arrival), each item drawn once. New + Open is what the rail badge
 * counts.
 */
function InboxTabs({
  rows,
  waiting,
  questionsError,
}: {
  rows: ReturnType<typeof allNeeds>;
  waiting: number;
  questionsError: string | null;
}) {
  const [tab, setTab] = useState<InboxState>("new");
  const count = (st: InboxState) => rows.filter((r) => r.counted && r.state === st).length;
  const shown = rows.filter((r) => r.state === tab);
  const label = STATE_TABS.find((t) => t.id === tab)!.label;
  return (
    <Panel title="Needs you" count={waiting} testId="inbox-needs">
      <div className="px-4 pt-1 max-[600px]:px-3" data-testid="inbox-state-tabs">
        <TabBar
          label="Inbox by state"
          tabs={STATE_TABS.map((t) => ({ id: t.id, label: t.label, count: count(t.id) }))}
          value={tab}
          onChange={setTab}
        />
      </div>
      {questionsError && (
        <div className="px-4 pt-3" data-testid="inbox-questions-error">
          <ErrorNote>{questionsError}</ErrorNote>
        </div>
      )}
      <div role="tabpanel" aria-label={label} data-testid={`inbox-tab-${tab}`}>
        {shown.length === 0 ? (
          <Empty>
            Nothing {label.toLowerCase()}{" "}
            {tab === "new" && (
              <InfoTip label="the inbox" align="start">
                Checkpoints that need a decision, cost approvals, feedback to review and the questions asked of you land here.
              </InfoTip>
            )}
          </Empty>
        ) : (
          GROUPS.map((g) => (
            <NeedTable key={g.id} title={g.title} testId={`inbox-${g.id}`} rows={shown.filter((r) => r.group === g.id)} />
          ))
        )}
      </div>
    </Panel>
  );
}
