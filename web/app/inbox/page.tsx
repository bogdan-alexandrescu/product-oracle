"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Chip, Empty, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { TabBar } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, markInboxSeen, waitingChanged } from "@/lib/waiting";

import { useAccessRequestRows } from "./_access";
import { useActed } from "./_actions";
import { allNeeds, NeedTable, sourceNeeds, STATE_TABS, useFixedHere, waitingNeeds, type InboxState, type NeedGroup } from "./_needs";
import { useQuestionRows } from "./_questions";

type Source = Schemas["SourceOut"];

export default function InboxPage() {
  const q = useQuery("inbox", loadInbox);
  // Questions asked of me (I3): their own group, counted with the rest as the rail badge counts.
  const questionsQ = useQuery("inbox|questions", loadMyQuestions);
  // My sources needing an edit before they sync again (a failure here only hides the group).
  const sourcesQ = useQuery("inbox|sources", () => unwrap(api.GET("/v1/sources")));
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
  // Answered in place (C2): the row shows its outcome until the tab changes, then Done.
  const asked = useQuestionRows(questionsQ.data ?? [], questionsQ.reload);
  // A5: access requests, approved or declined in place until the tab changes.
  const requests = useAccessRequestRows(inbox?.access_requests ?? [], q.reload);

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

  // D14: a feedback row's own actions; what they did shows above the rows, Undo with it.
  const { onActed, notice } = useActed(() => Promise.all([q.reload(), questionsQ.reload()]));

  const seenBefore = arrived ? arrivalQ.data : inbox?.last_seen_at;
  // D9: the child rows I fixed on this visit stay, done with Undo.
  const fixed = useFixedHere();
  const rows = inbox ? allNeeds(inbox, asked.rows, busy, act, seenBefore, onActed, false, fixed, requests.rows) : null;
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
      {inbox && rows && (
        <InboxTabs rows={rows} waiting={waiting ?? 0} questionsError={questionsQ.error} notice={notice} onTabChange={() => {
            asked.moveSettled();
            requests.moveSettled();
          }}
        />
      )}
      {asked.sheet}
      {sourcesQ.data && <SourcesNeedingAttention sources={sourcesQ.data} />}
    </Page>
  );
}

/**
 * My sources that need an edit before they sync again: their own panel, outside "Needs you",
 * whose count is the rail badge's and Home's (lib/waiting), as is the header's.
 */
function SourcesNeedingAttention({ sources }: { sources: Source[] }) {
  const rows = sourceNeeds(sources);
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <Panel title="Sources that need attention" count={rows.length}>
        <NeedTable title="Sources that need attention" testId="inbox-sources" rows={rows} />
      </Panel>
    </div>
  );
}

/**
 * The groups a tab draws, in order; each is one table under its own label. `heading`: shown
 * above the group, for one that is not something to act on.
 */
const GROUPS: { id: NeedGroup; title: string; heading?: ReactNode }[] = [
  { id: "checkpoints", title: "Checkpoints" },
  { id: "tracks", title: "Track health" },
  {
    id: "deliveries",
    title: "Decision not delivered yet",
    heading: (
      <>
        Decision not delivered yet
        <InfoTip label="decisions not delivered yet" align="start">
          These decisions are recorded and final: nobody needs to decide again. SwarmCloud has not taken them yet, so Oracle sends
          each again on every tick until it does.
        </InfoTip>
      </>
    ),
  },
  { id: "discussions", title: "Discussions" },
  { id: "approvals", title: "Cost approvals" },
  { id: "overruns", title: "Paused on overrun" },
  { id: "lookups", title: "Stuck runs" },
  { id: "imports", title: "Couldn't import" },
  { id: "revoke-failures", title: "Couldn't revoke access" },
  { id: "access-failures", title: "Access to Oracle not changed" },
  { id: "access-requests", title: "Access requests" },
  { id: "report-failures", title: "Report not posted to Slack" },
  { id: "reports", title: "Reports" },
  { id: "strategy", title: "Strategy drift" },
  { id: "dates", title: "Dates to verify" },
  { id: "launches", title: "Launches" },
  { id: "requests", title: "Requests" },
  { id: "rituals", title: "Rituals" },
  { id: "outcomes", title: "Outcomes" },
  { id: "oracle-actions", title: "Oracle did" },
  { id: "feedback", title: "Feedback" },
  { id: "decisions", title: "Decisions" },
  { id: "questions", title: "Questions" },
  { id: "revising", title: "Sent back by Oracle" },
  { id: "searches", title: "Looking for earlier submissions" },
  { id: "shipped", title: "Shipped", heading: "Shipped: what you asked for" },
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
  notice,
  onTabChange,
}: {
  rows: ReturnType<typeof allNeeds>;
  waiting: number;
  questionsError: string | null;
  notice: ReactNode;
  /** The tab changed: what was settled in place moves on. */
  onTabChange: () => void;
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
          onChange={(t) => {
            setTab(t);
            onTabChange();
          }}
        />
      </div>
      {questionsError && (
        <div className="px-4 pt-3" data-testid="inbox-questions-error">
          <ErrorNote>{questionsError}</ErrorNote>
        </div>
      )}
      {notice}
      <div role="tabpanel" aria-label={label} data-testid={`inbox-tab-${tab}`}>
        {shown.length === 0 ? (
          <Empty>
            Nothing {label.toLowerCase()}{" "}
            {tab === "new" && (
              <InfoTip label="the inbox" align="start">
                Checkpoints that need a decision, cost approvals, feedback to review, the questions asked of you and, for owners,
                the weekly alignment report land here.
              </InfoTip>
            )}
          </Empty>
        ) : (
          GROUPS.map((g) => (
            <NeedTable key={g.id} title={g.title} heading={g.heading} testId={`inbox-${g.id}`} rows={shown.filter((r) => r.group === g.id)} />
          ))
        )}
      </div>
    </Panel>
  );
}
