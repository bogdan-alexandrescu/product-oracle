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
import { allNeeds, NeedTable, SOURCE_COLUMNS, sourceNeeds, STATE_TABS, useFixedHere, usePerms, waitingNeeds, type InboxState, type NeedGroup } from "./_needs";
import { useQuestionRows } from "./_questions";
import { useReminderRows } from "./_reminders";
import { useWebhookRows } from "./_webhooks";

type Source = Schemas["SourceOut"];

/** qa-company-42: what a row's action did, said in the banner (by the action's key). */
const ACTED: [prefix: string, message: string][] = [
  ["report-retry-", "Posting the report again"],
  ["report-dismiss-", "Dismissed"],
  ["ritual-retry-", "Preparing it again"],
  ["open-answer-", ""],
  ["open-", ""],
  ["approve-", "Approved: run started"],
  ["resume-", "Run resumed"],
  ["cancel-", "Run cancelled"],
  ["retry-", "Trying again"],
  ["lookup-", "Looking for the run again"],
  ["import-", "Trying the import again"],
  ["stop-", "Stopped cancelling"],
  ["again-", "Cancelling again"],
  ["dismiss-", "Dismissed"],
  ["reaffirm-", "Reaffirmed for 90 more days"],
  ["verify-", "Dates verified"],
  ["undo-", "Undone"],
  ["reopen-", "Reopened"],
];

function actedMessage(key: string): string | null {
  return ACTED.find(([prefix]) => key.startsWith(prefix))?.[1] || null;
}

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
  // D14: a feedback row's own actions; what they did shows above the rows, Undo with it.
  const { onActed, notice, say } = useActed(() => Promise.all([q.reload(), questionsQ.reload()]));
  // A5: access requests; a decided one moves to Done or Declined at once, Undo in the banner (qa-company-7).
  const requests = useAccessRequestRows(inbox?.access_requests ?? [], q.reload, onActed);

  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    // qa-company-42: the last action's banner never stays over this one's.
    say(null);
    try {
      await call();
      say(actedMessage(key));
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
  // D9: the child rows I fixed on this visit stay, done with Undo.
  const fixed = useFixedHere();
  // qa-company-3: each row draws only the actions the signed-in person's role can take.
  const perms = usePerms();
  // I1: webhook notices (paused, failing, a changed address), from my notifications.
  const webhookRows = useWebhookRows(busy, act, seenBefore);
  // Remind on a one-pager: a PRD's owner or decider nudged me to review its draft.
  const reminderRows = useReminderRows(seenBefore);
  const rows = inbox ? [...allNeeds(inbox, asked.rows, busy, act, seenBefore, onActed, false, fixed, requests.rows, perms), ...webhookRows, ...reminderRows] : null;
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
        <InboxTabs
          // qa-company-17: Next keeps this page while I am elsewhere and shows it again, its
          // reads run again; each visit's own arrival starts the tabs afresh (a tab picked on the
          // last visit does not hold an emptied New open).
          key={arrived ? (arrivalQ.data ?? "first") : "arriving"}
          rows={rows}
          waiting={waiting ?? 0} questionsError={questionsQ.error} notice={notice} onTabChange={() => {
            asked.moveSettled();
          }}
        />
      )}
      {asked.sheet}
      {/* qa-shell-19: only someone who can edit a source is asked to fix one. */}
      {sourcesQ.data && perms.can("update_source") && <SourcesNeedingAttention sources={sourcesQ.data} mayEdit />}
    </Page>
  );
}

/**
 * My sources that need an edit before they sync again: their own panel, outside "Needs you",
 * whose count is the rail badge's and Home's (lib/waiting), as is the header's.
 */
function SourcesNeedingAttention({ sources, mayEdit }: { sources: Source[]; mayEdit: boolean }) {
  const rows = sourceNeeds(sources, mayEdit);
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <Panel title="Sources that need attention" count={rows.length}>
        <NeedTable title="Sources that need attention" testId="inbox-sources" rows={rows} columns={SOURCE_COLUMNS} />
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
  { id: "share-revocations", title: "Share links revoked" },
  { id: "access-requests", title: "Access requests" },
  { id: "report-failures", title: "Report not posted to Slack" },
  { id: "reports", title: "Reports" },
  { id: "strategy", title: "Strategy drift" },
  { id: "dates", title: "Dates to verify" },
  { id: "launches", title: "Launches" },
  { id: "requests", title: "Requests" },
  { id: "rituals", title: "Rituals" },
  { id: "metrics", title: "Metrics" },
  { id: "outcomes", title: "Outcomes" },
  { id: "webhooks", title: "Webhooks" },
  { id: "reminders", title: "Review reminders" },
  { id: "oracle-actions", title: "Oracle did" },
  { id: "feedback", title: "Feedback" },
  { id: "decisions", title: "Decisions" },
  { id: "questions", title: "Questions" },
  { id: "revising", title: "Sent back by Oracle" },
  { id: "searches", title: "Looking for earlier submissions" },
  { id: "shipped", title: "Shipped", heading: "Shipped: what you asked for" },
  // qa-company-4: items only another role acts on: shown, never counted as waiting on me.
  {
    id: "fyi",
    title: "For your information",
    heading: (
      <>
        For your information
        <InfoTip label="for your information" align="start">
          Someone with another role decides these. They are here so you know; they are not waiting on you.
        </InfoTip>
      </>
    ),
  },
];

/**
 * ONE Inbox (owner, 2026-10-20): every kind of item in a single list with state tabs, New
 * first (the default on arrival when it has items, else Seen), each item drawn once. New +
 * Seen is what the rail badge counts.
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
  const count = (st: InboxState) => rows.filter((r) => r.counted && r.state === st).length;
  // qa-company-2: the Inbox opens on the tab that holds what waits: New when it has items,
  // else Seen (what I have seen and not handled yet), so "11 waiting" never opens on "Nothing new".
  const [chosen, setTab] = useState<InboxState>(() => (count("new") === 0 && count("open") > 0 ? "open" : "new"));
  // Until the person picks a tab on this visit, the rule holds as the rows load: New that
  // empties into Seen shows Seen.
  const [picked, setPicked] = useState(false);
  const tab: InboxState = !picked && chosen === "new" && count("new") === 0 && count("open") > 0 ? "open" : chosen;
  const pick = (t: InboxState) => {
    setPicked(true);
    setTab(t);
    onTabChange();
  };
  const shown = rows.filter((r) => r.state === tab);
  const label = STATE_TABS.find((t) => t.id === tab)!.label;
  // qa-company-16: the heading and its count follow the tab: New and Seen are what needs me
  // (the rail badge's count); Staged, Declined and Done are named, with their own counts.
  const live = tab === "new" || tab === "open";
  return (
    <Panel title={live ? "Needs you" : label} count={live ? waiting : count(tab)} testId="inbox-needs">
      {/* qa-company-47: on a phone the five tabs keep one line: smaller tabs, no "0" counts. */}
      <div
        className="px-4 pt-1 max-[600px]:overflow-x-auto max-[600px]:px-2 max-[600px]:[&_[role=tab]]:px-1.5 max-[600px]:[&_[role=tablist]]:flex-nowrap"
        data-testid="inbox-state-tabs"
      >
        <TabBar
          label="Inbox by state"
          size="sm"
          tabs={STATE_TABS.map((t) => ({ id: t.id, label: t.label, count: count(t.id) || null }))}
          value={tab}
          onChange={pick}
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
          <Empty testId="inbox-tab-empty">
            {/* qa-company-43: New empties once seen; say where the waiting items went. */}
            {tab === "new" ? (
              count("open") > 0 ? (
                <>
                  Nothing new since your last visit · {count("open")} still waiting in{" "}
                  <button type="button" className="font-semibold text-accent-ink underline" onClick={() => pick("open")}>
                    Seen
                  </button>{" "}
                </>
              ) : count("staged") + count("declined") + count("done") === 0 ? (
                // qa-shell-9: an empty Inbox says what will arrive, not only that nothing is here.
                <>Nothing needs you yet. Decisions, approvals and questions for you will show up here. </>
              ) : (
                <>Nothing new </>
              )
            ) : (
              <>Nothing {label.toLowerCase()} </>
            )}
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
