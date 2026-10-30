"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { ClaudeOffNotice } from "@/components/ClaudeOffNotice";
import { Chip, Empty, Icon, InfoTip, LinkButton, Notice, Page, PageHeader, Panel, Split } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, waitingChanged } from "@/lib/waiting";

import { useAccessRequestRows } from "../inbox/_access";
import { useActed } from "../inbox/_actions";
import { allNeeds, NeedTable, usePerms, waitingNeeds, type Need, type StatedNeed } from "../inbox/_needs";
import { useQuestionRows } from "../inbox/_questions";
import { GoalsPanel } from "./_goals-panel";
import { FlightInspector, FlightTable, type Flight, type GoalIndex } from "./_in-flight";
import { baselineStep, SetupChip, SetupPanel, setupOpen } from "./_setup";
import { WelcomePanel } from "./_welcome";
import { useGoals } from "./_use-goals";

/** Runs that are still going: under way, or waiting on a person. */
const IN_FLIGHT = new Set(["running", "awaiting_checkpoint", "awaiting_approval", "paused_overrun"]);
/** A phone's width, as the layout's max-[600px]. */
const PHONE = "(max-width: 600px)";

/**
 * qa-company-5: how many of each kind wait, as a plain count. The Inbox has no view per
 * kind, so a count is not a link that seems to filter; the Inbox link beside them opens it.
 */
function Count({ label, n, testId }: { label: string; n: number; testId: string }) {
  return (
    <Chip kind="line" data-testid={testId}>
      {label} <b className="tnum">{n}</b>
    </Chip>
  );
}

/** Needs you shows this many lines; the rest are one click away in the Inbox. */
const MAX_NEEDS = 7;

/**
 * At most `max` lines, in the Inbox's order, never without a question when there is one
 * (I3); past `max`, the last line says how many more wait in the Inbox.
 */
function pickNeeds(rows: StatedNeed[], max: number): Need[] {
  if (rows.length <= max) return rows;
  const questions = rows.filter((r) => r.group === "questions");
  const others = rows.filter((r) => r.group !== "questions");
  const keep = max - 1;
  const shown = questions.length === 0 || others.length < keep ? rows.slice(0, keep) : [...others.slice(0, keep - 1), questions[0]];
  const more = rows.length - shown.length;
  return [
    ...shown,
    {
      key: "more",
      icon: "inbox",
      kind: "More",
      item: (
        <Link href="/inbox" className="font-semibold text-accent-ink hover:underline" data-testid="home-needs-more">
          +{more} more in Inbox
        </Link>
      ),
      context: null,
      at: null,
      action: null,
    },
  ];
}

/**
 * Home (I3, B1 Split): goals with distance to go, what needs the signed-in person, and
 * what is in flight, with the selected row in the inspector. Built only on data the API
 * serves; a block without data says what to do next in one line.
 *
 * First paint costs a fixed number of calls whatever the company's size: five lists (goals,
 * inbox, questions asked of me, PRDs, runs), the setup checklist, one trend per goal shown
 * (at most four), and the selected row's inspector. Nothing is fetched per run, per PRD or
 * per hidden goal. An owner's Home also reads the Claude account pool, for the notice that
 * Oracle's AI is off (#403).
 */
export default function HomePage() {
  const { can, capsReady } = useMe();
  // #370: New PRD starts a draft (a PRD, any approver's); Build the baseline opens where the baseline's writers build it.
  const canWrite = can("start_draft", true);
  const canBuild = can("confirm_entity");
  // #403: only a role that can act on the notice (add an account, set the fallback: owners) reads the pool.
  const owner = can("add_claude_account");
  const poolQ = useQuery(owner ? "home|claude-pool" : "home|no-pool", () => (owner ? unwrap(api.GET("/v1/claude-accounts")) : Promise.resolve(null)));

  const inboxQ = useQuery("home|inbox", loadInbox);
  // Asked of me, filtered by the API so none is cut off; a failure shows in Needs you.
  const questionsQ = useQuery("home|questions", loadMyQuestions);
  const docsQ = useQuery("home|documents", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const runsQ = useQuery("home|runs", () => unwrap(api.GET("/v1/runs")));
  // A1: the Set up checklist, read live; only the hide choice is stored (a preference).
  const setupQ = useQuery("home|setup", () => unwrap(api.GET("/v1/setup")));
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  async function hideSetup(hidden: boolean) {
    setSetupBusy(true);
    setSetupError(null);
    const before = setupQ.data;
    setupQ.setData((s) => (s ? { ...s, hidden } : s));
    try {
      await unwrap(api.PATCH("/v1/me/preferences", { body: { setup_hidden: hidden } }));
    } catch (e) {
      setupQ.setData(() => before);
      setSetupError(errorMessage(e));
    } finally {
      setSetupBusy(false);
    }
  }
  const setup = setupOpen(setupQ.data) ? setupQ.data : undefined;
  // A1 welcome: an invited member's first Home, until they dismiss it (a preference).
  // The panel closes once the preference is saved, so a reload right after Dismiss
  // cannot bring it back (the button is disabled while the save runs).
  async function dismissWelcome() {
    setSetupBusy(true);
    setSetupError(null);
    try {
      await unwrap(api.PATCH("/v1/me/preferences", { body: { welcome_dismissed: true } }));
      setupQ.setData((s) => (s ? { ...s, welcome: false } : s));
    } catch (e) {
      setSetupError(errorMessage(e));
    } finally {
      setSetupBusy(false);
    }
  }

  const { goals, history, historyPending, error: goalsError, loading: goalsLoading } = useGoals("home");
  const goalIndex: GoalIndex = useMemo(
    () => new Map((goals ?? []).map((g) => [g.id, { id: g.id, tag: g.tag, title: g.title, proposed: g.proposed }])),
    [goals],
  );

  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data]);
  const inReview = docs.filter((d) => d.status === "in_review").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const activeRuns = (runsQ.data ?? []).filter((r) => IN_FLIGHT.has(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const flights: Flight[] | undefined =
    docsQ.data && runsQ.data
      ? [
          ...inReview.map((doc): Flight => ({ kind: "prd", key: `prd:${doc.slug}`, doc })),
          ...activeRuns.map((run): Flight => ({ kind: "run", key: `run:${run.id}`, run })),
        ]
      : undefined;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = flights?.find((f) => f.key === picked) ?? flights?.[0] ?? null;
  // qa-company-32, qa-onboarding-39: on a phone the inspector waits for a tap on a row, then
  // shows right under In flight; untapped, the row alone says what is in flight.
  function pick(key: string) {
    setPicked(key);
    if (typeof window !== "undefined" && window.matchMedia(PHONE).matches) {
      requestAnimationFrame(() => document.getElementById("home-inspector-slot")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  }

  // Needs you: the Inbox's rows, then the stakeholder questions asked of the signed-in person.
  const [busy, setBusy] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  async function act(key: string, call: () => Promise<unknown>) {
    setBusy(key);
    setActError(null);
    try {
      await call();
      // Reload what the action changed; the rail badge reads the same reloads.
      invalidateWaiting();
      const reloads = Promise.all([inboxQ.reload(), questionsQ.reload(), runsQ.reload()]);
      waitingChanged();
      await reloads;
    } catch (e) {
      setActError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  // D14: feedback rows act in place (one primary action each); what they did shows here.
  const { onActed, notice } = useActed(() => Promise.all([inboxQ.reload(), questionsQ.reload()]));
  const inbox = inboxQ.data;
  // The API filters (asked of me, still open): Home counts exactly what the badge counts.
  // Answered here, a question stays in its line with its outcome (C2).
  const questionRows = useQuestionRows(questionsQ.data ?? [], questionsQ.reload);
  // A5: access requests, approved or declined in their line (as the Inbox).
  const requestRows = useAccessRequestRows(inbox?.access_requests ?? [], inboxQ.reload);
  // Needs you: the Inbox's New and Open items, each once (owner, 2026-10-20); a question
  // answered here stays shown, no longer counted.
  // qa-company-3: a line draws only the actions the signed-in person's role can take.
  const perms = usePerms();
  const all = inbox ? allNeeds(inbox, questionRows.rows, busy, act, inbox.last_seen_at ?? null, onActed, true, undefined, requestRows.rows, perms) : [];
  const needs = waitingNeeds(all);
  const visible = all.filter((r) => needs.includes(r) || ((r.group === "questions" || r.group === "access-requests") && !r.counted && r.state !== "done"));
  // Checkpoints, cost approvals and overruns: "Approvals", what they are (qa-shell-6), not the
  // decision log's Decisions.
  const approvals = needs.filter((r) => r.group === "checkpoints" || r.group === "approvals" || r.group === "overruns");
  // Stuck runs and failed imports: counted in the badge, so drawn here too (searches are not).
  const runs = needs.filter((r) => r.group === "lookups" || r.group === "imports");
  // Revokes a removed member's disable could not make, and access changes still failing
  // (owners only), as the Inbox lists them; access requests (owners and approvers, A5).
  const access = needs.filter((r) => r.group === "revoke-failures" || r.group === "access-failures" || r.group === "access-requests");
  const reviews = needs.filter((r) => r.group === "feedback");
  const asked = needs.filter((r) => r.group === "questions");
  const shownNeeds = pickNeeds(visible, MAX_NEEDS);
  // The rail badge's count: the Inbox's New + Open items.
  const waiting = inbox ? needs.length : undefined;
  const openItems = new Map((inbox?.feedback ?? []).map((d) => [d.document_id, d.open_count]));

  const nothingInFlight = flights !== undefined && flights.length === 0;
  const flightHeader = (
    <span className="font-display text-lg leading-6 font-bold tracking-heading text-text">
      In flight
      {flights && flights.length > 0 && <span className="tnum ml-1.5 text-accent-ink">{flights.length}</span>}
    </span>
  );
  const newPrd = (className?: string) =>
    canWrite && (
      <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus" className={className}>
        New PRD
      </LinkButton>
    );

  return (
    <Page>
      <PageHeader
        title="Home"
        status={
          ((waiting != null && waiting > 0) || setup?.hidden) && (
            <>
              {waiting != null && waiting > 0 && <Chip kind="acc">{waiting} waiting</Chip>}
              {setup?.hidden && <SetupChip setup={setup} onShow={() => hideSetup(false)} busy={setupBusy} />}
            </>
          )
        }
        // The empty In flight line carries New PRD itself; never draw it twice.
        action={!nothingInFlight && newPrd()}
      />
      <Split
        inspector={
          selected ? (
            <div id="home-inspector-slot" data-testid="home-inspector-slot" className={picked ? "scroll-mt-3" : "max-[600px]:hidden"}>
              <FlightInspector f={selected} openItems={openItems} docs={docs} goalIndex={goalIndex} />
            </div>
          ) : undefined
        }
      >
        {owner && poolQ.data && <ClaudeOffNotice page={poolQ.data} />}
        {setupError && <Notice tone="error">{setupError}</Notice>}
        {setupQ.data?.welcome && capsReady && <WelcomePanel onDismiss={dismissWelcome} busy={setupBusy} />}
        {setup && !setup.hidden && <SetupPanel setup={setup} onHide={() => hideSetup(true)} busy={setupBusy} />}

        <GoalsPanel
          goals={goals}
          history={history}
          historyPending={historyPending}
          error={goalsError}
          loading={goalsLoading}
          canImport={canBuild}
          canInterview={can("start_goal_interview")}
          baseline={baselineStep(setupQ.data)}
        />

        <Panel
          title="Needs you"
          count={waiting ? waiting : undefined}
          testId="home-needs"
          tools={
            <>
              {/* qa-shell-16: what this count counts, and why Simple's Home says another number. */}
              <InfoTip label="Needs you" side="bottom">
                Everything the Inbox has waiting on you: approvals, runs, access requests, reviews and the questions asked of you.
                Simple&apos;s Home counts something else, the product decisions on PRDs that wait on you, so its number can differ.
              </InfoTip>
              {/* qa-company-5: plain counts; the Inbox link opens the Inbox, where the items are. */}
              {approvals.length > 0 && <Count label="Approvals" n={approvals.length} testId="home-count-approvals" />}
              {runs.length > 0 && <Count label="Runs" n={runs.length} testId="home-count-runs" />}
              {access.length > 0 && <Count label="Access" n={access.length} testId="home-count-access" />}
              {reviews.length > 0 && <Count label="Reviews" n={reviews.length} testId="home-count-reviews" />}
              {asked.length > 0 && <Count label="Questions" n={asked.length} testId="home-count-questions" />}
              <Link
                href="/inbox"
                data-testid="home-inbox-link"
                className="ml-1 inline-flex h-8 items-center gap-1 rounded-lg px-1.5 text-[15px] font-semibold text-accent-ink hover:underline"
              >
                Inbox
                <Icon name="arrow" size={16} />
              </Link>
            </>
          }
        >
          {inboxQ.error && (
            <div className="p-4">
              <Notice tone="error">{inboxQ.error}</Notice>
            </div>
          )}
          {questionsQ.error && (
            <div className="px-4 pt-3" data-testid="home-questions-error">
              <Notice tone="error">{questionsQ.error}</Notice>
            </div>
          )}
          {actError && (
            <div className="px-4 pt-3">
              <Notice tone="error">{actError}</Notice>
            </div>
          )}
          {notice}
          {inbox && !questionsQ.loading && !questionsQ.error && shownNeeds.length === 0 && (
            <Empty testId="home-needs-empty">Nothing waiting</Empty>
          )}
          <NeedTable title="Needs you" testId="home-needs-table" rows={shownNeeds} compact />
          {questionRows.sheet}
        </Panel>

        {/* qa-company-31: In flight is its own panel, apart from Needs you. */}
        <section aria-label="In flight" data-testid="home-in-flight" className="min-w-0 overflow-clip rounded-panel border border-line bg-surface shadow-panel">
          <div data-testid="home-in-flight-phone-title" className="hidden min-h-12 items-center border-b border-line bg-surface2 px-3 max-[600px]:flex">
            {flightHeader}
          </div>
          {(docsQ.error || runsQ.error) && (
            <div className="p-4">
              <Notice tone="error">{docsQ.error ?? runsQ.error}</Notice>
            </div>
          )}
          {nothingInFlight ? (
            <div data-testid="home-in-flight-empty" className="flex flex-wrap items-center gap-3 px-4 py-4 max-[600px]:px-3">
              <span className="hidden font-display text-lg font-bold tracking-heading min-[601px]:inline">In flight</span>
              <span className="text-[15px] font-semibold text-text2">Nothing in flight</span>
              {newPrd("ml-auto")}
            </div>
          ) : (
            <FlightTable
              rows={flights}
              loading={docsQ.loading || runsQ.loading}
              selected={selected?.key ?? null}
              onSelect={pick}
              header={flightHeader}
              docs={docs}
            />
          )}
        </section>
      </Split>
    </Page>
  );
}
