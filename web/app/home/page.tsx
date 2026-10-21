"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Chip, Empty, Icon, LinkButton, Notice, Page, PageHeader, Panel, Split } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, loadMyQuestions, waitingChanged } from "@/lib/waiting";

import { useActed } from "../inbox/_actions";
import { allNeeds, CountChip, NeedTable, questionNeeds, waitingNeeds, type Need, type StatedNeed } from "../inbox/_needs";
import { goalViews, historyOf, shownGoals, type Point } from "./_goals";
import { GoalsPanel } from "./_goals-panel";
import { FlightInspector, FlightTable, type Flight, type GoalIndex } from "./_in-flight";

/** Runs that are still going: under way, or waiting on a person. */
const IN_FLIGHT = new Set(["running", "awaiting_checkpoint", "awaiting_approval", "paused_overrun"]);
/** Needs you shows this many lines; the rest are one click away in the Inbox. */
const MAX_NEEDS = 7;
/** A goal's trend reads at most this many of its newest revisions (six monthly readings and change). */
const TREND_REVISIONS = 24;

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
 * inbox, questions asked of me, PRDs, runs), one trend per goal shown (at most four), and
 * the selected row's inspector. Nothing is fetched per run, per PRD or per hidden goal.
 */
export default function HomePage() {
  const { role } = useMe();
  const canWrite = hasRole(role, "approver");

  const goalsQ = useQuery("home|goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const inboxQ = useQuery("home|inbox", loadInbox);
  // Asked of me, filtered by the API so none is cut off; a failure shows in Needs you.
  const questionsQ = useQuery("home|questions", loadMyQuestions);
  const docsQ = useQuery("home|documents", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const runsQ = useQuery("home|runs", () => unwrap(api.GET("/v1/runs")));

  const goals = useMemo(() => (goalsQ.data ? goalViews(goalsQ.data) : undefined), [goalsQ.data]);
  const goalIndex: GoalIndex = useMemo(
    () => new Map((goals ?? []).map((g) => [g.id, { tag: g.tag, title: g.title, proposed: g.proposed }])),
    [goals],
  );

  // A trend for each goal shown that has a current value, from its newest revisions only.
  const tracked = (goals ? shownGoals(goals) : []).filter((g) => g.currentText).map((g) => g.id);
  const historyQ = useQuery(
    `home|history|${tracked.join(",")}`,
    async () => {
      const lists = await Promise.all(
        tracked.map((id) =>
          unwrap(
            api.GET("/v1/baseline/entities/{entity_id}/revisions", {
              params: { path: { entity_id: id }, query: { limit: TREND_REVISIONS } },
            }),
          ).catch(() => []),
        ),
      );
      return new Map<string, Point[]>(tracked.map((id, i) => [id, historyOf(lists[i])]));
    },
    { keepPrevious: true },
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
  // The API filters (asked of me, still asked): Home counts exactly what the badge counts.
  const questions = questionNeeds(questionsQ.data ?? [], docs);
  // Needs you: the Inbox's New and Open items, each once (owner, 2026-10-20).
  const needs = inbox ? waitingNeeds(allNeeds(inbox, questions, busy, act, inbox.last_seen_at ?? null, onActed, true)) : [];
  const decisions = needs.filter((r) => r.group === "checkpoints" || r.group === "approvals" || r.group === "overruns");
  // Stuck runs and failed imports: counted in the badge, so drawn here too (searches are not).
  const runs = needs.filter((r) => r.group === "lookups" || r.group === "imports");
  // Revokes a removed member's disable could not make (owners only), as the Inbox lists them.
  const access = needs.filter((r) => r.group === "revoke-failures");
  const reviews = needs.filter((r) => r.group === "feedback");
  const asked = needs.filter((r) => r.group === "questions");
  const shownNeeds = pickNeeds(needs, MAX_NEEDS);
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
        status={waiting != null && waiting > 0 && <Chip kind="acc">{waiting} waiting</Chip>}
        // The empty In flight line carries New PRD itself; never draw it twice.
        action={!nothingInFlight && newPrd()}
      />
      <Split
        inspector={selected ? <FlightInspector f={selected} openItems={openItems} docs={docs} goalIndex={goalIndex} /> : undefined}
      >
        <GoalsPanel
          goals={goals}
          history={historyQ.data ?? new Map()}
          error={goalsQ.error}
          loading={goalsQ.loading}
          canImport={canWrite}
        />

        <Panel
          title="Needs you"
          count={waiting ? waiting : undefined}
          testId="home-needs"
          tools={
            <>
              {decisions.length > 0 && <CountChip label="Decisions" n={decisions.length} />}
              {runs.length > 0 && <CountChip label="Runs" n={runs.length} />}
              {access.length > 0 && <CountChip label="Access" n={access.length} />}
              {reviews.length > 0 && <CountChip label="Reviews" n={reviews.length} />}
              {asked.length > 0 && <CountChip label="Questions" n={asked.length} />}
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

          <section aria-label="In flight" data-testid="home-in-flight" className="border-t border-line">
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
                onSelect={setPicked}
                header={flightHeader}
              />
            )}
          </section>
        </Panel>
      </Split>
    </Page>
  );
}
