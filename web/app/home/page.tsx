"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Chip, Empty, Icon, LinkButton, Notice, Page, PageHeader, Panel, Split } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CountChip, inboxNeeds, NeedTable, type Need } from "../inbox/_needs";
import { goalViews, historyOf, type Point } from "./_goals";
import { GoalsPanel } from "./_goals-panel";
import { FlightInspector, FlightTable, type Flight, type RowGoal } from "./_in-flight";

/** Runs that are still going: under way, or waiting on a person. */
const IN_FLIGHT = new Set(["running", "awaiting_checkpoint", "awaiting_approval", "paused_overrun"]);
/** Needs you shows this many lines; the rest are one click away in the Inbox. */
const MAX_NEEDS = 7;

/**
 * Home (I3, B1 Split): goals with distance to go, what needs the signed-in person, and
 * what is in flight, with the selected row in the inspector. Built only on data the API
 * serves; a block without data says what to do next in one line.
 */
export default function HomePage() {
  const router = useRouter();
  const { me } = useMe();

  const goalsQ = useQuery("home|goals", () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })));
  const inboxQ = useQuery("home|inbox", () => unwrap(api.GET("/v1/inbox")));
  const questionsQ = useQuery("home|questions", () =>
    unwrap(api.GET("/v1/questions", { params: { query: { status: "asked" } } })).catch(() => []),
  );
  const docsQ = useQuery("home|documents", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const runsQ = useQuery("home|runs", () => unwrap(api.GET("/v1/runs")));

  const goals = useMemo(() => (goalsQ.data ? goalViews(goalsQ.data) : undefined), [goalsQ.data]);
  const byGoalId = useMemo(() => new Map((goals ?? []).map((g) => [g.id, g])), [goals]);

  // A goal's trend comes from its recorded revisions; a goal without a current value has none.
  const tracked = (goals ?? []).filter((g) => g.current).map((g) => g.id);
  const historyQ = useQuery(`home|history|${tracked.join(",")}`, async () => {
    const lists = await Promise.all(
      tracked.map((id) =>
        unwrap(api.GET("/v1/baseline/entities/{entity_id}/revisions", { params: { path: { entity_id: id } } })).catch(() => []),
      ),
    );
    return new Map<string, Point[]>(tracked.map((id, i) => [id, historyOf(lists[i])]));
  });

  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data]);
  const inReview = docs.filter((d) => d.status === "in_review").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const activeRuns = (runsQ.data ?? []).filter((r) => IN_FLIGHT.has(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Goal tags per document: the goals its latest version's sections trace to.
  const traced = [
    ...new Set([...inReview.map((d) => d.slug), ...activeRuns.map((r) => r.document_slug).filter((s): s is string => !!s)]),
  ]
    .map((slug) => docs.find((d) => d.slug === slug))
    .filter((d) => d && d.latest_version != null)
    .map((d) => ({ slug: d!.slug, n: d!.latest_version! }));
  const tracesQ = useQuery(`home|traces|${traced.map((t) => `${t.slug}@${t.n}`).join(",")}`, async () => {
    const out = await Promise.all(
      traced.map((t) =>
        unwrap(api.GET("/v1/documents/{doc}/versions/{n}/trace", { params: { path: { doc: t.slug, n: t.n } } })).catch(() => null),
      ),
    );
    return new Map(traced.map((t, i) => [t.slug, [...new Set(out[i]?.sections.flatMap((s) => s.goals.map((g) => g.id)) ?? [])]]));
  });
  const goalsOf = (slug: string | null | undefined): RowGoal[] =>
    (slug ? (tracesQ.data?.get(slug) ?? []) : [])
      .map((id) => byGoalId.get(id))
      .filter((g) => !!g)
      .sort((a, b) => a!.tag.localeCompare(b!.tag, undefined, { numeric: true }))
      .map((g) => ({ tag: g!.tag, title: g!.title, proposed: g!.proposed }));

  // Each run's segments: what it has done and what comes next.
  const runIds = activeRuns.map((r) => r.id);
  const detailsQ = useQuery(`home|run-details|${runIds.join(",")}`, async () => {
    const out = await Promise.all(
      runIds.map((id) => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: id } } })).catch(() => undefined)),
    );
    return new Map(runIds.map((id, i) => [id, out[i]]));
  });

  const flights: Flight[] | undefined =
    docsQ.data && runsQ.data
      ? [
          ...inReview.map((doc): Flight => ({ kind: "prd", key: `prd:${doc.slug}`, doc, goals: goalsOf(doc.slug) })),
          ...activeRuns.map(
            (run): Flight => ({ kind: "run", key: `run:${run.id}`, run, detail: detailsQ.data?.get(run.id), goals: goalsOf(run.document_slug) }),
          ),
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
      await Promise.all([inboxQ.reload(), runsQ.reload()]);
    } catch (e) {
      setActError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const inbox = inboxQ.data;
  const needs = inbox ? inboxNeeds(inbox, busy, act, true) : null;
  const asked = (questionsQ.data ?? []).filter((q) => q.status === "asked" && !!me?.user_id && q.asked_to === me.user_id);
  const questions: Need[] = asked.map((q) => {
    const doc = docs.find((d) => d.id === q.document_id);
    return {
      key: q.id,
      icon: "ask",
      kind: "Asked you",
      item: (
        <span className="truncate" title={q.prompt}>
          {q.prompt}
        </span>
      ),
      context: <span className="block truncate">{doc?.title ?? "–"}</span>,
      at: q.created_at,
      action: doc ? (
        <LinkButton href={`/documents/${doc.slug}`} aria-label={`Open ${doc.title}`}>
          Open
        </LinkButton>
      ) : null,
    };
  });
  const decisions = needs ? [...needs.checkpoints, ...needs.approvals, ...needs.overruns] : [];
  const reviews = needs?.feedback ?? [];
  const allNeeds = [...decisions, ...reviews, ...questions];
  const waiting = inbox ? inbox.total + questions.length : undefined;
  const openItems = new Map((inbox?.feedback ?? []).map((d) => [d.document_id, d.open_count]));

  const nothingInFlight = flights !== undefined && flights.length === 0;
  const flightHeader = (
    <span className="font-display text-lg leading-6 font-bold tracking-heading text-text">
      In flight
      {flights && flights.length > 0 && <span className="tnum ml-1.5 text-accent-ink">{flights.length}</span>}
    </span>
  );

  return (
    <Page>
      <PageHeader
        title="Home"
        status={waiting != null && waiting > 0 && <Chip kind="acc">{waiting} waiting</Chip>}
        action={
          // The empty In flight line carries New PRD itself; never draw it twice.
          !nothingInFlight && (
            <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus">
              New PRD
            </LinkButton>
          )
        }
      />
      <Split inspector={selected ? <FlightInspector f={selected} openItems={openItems} /> : undefined}>
        <GoalsPanel goals={goals} history={historyQ.data ?? new Map()} error={goalsQ.error} loading={goalsQ.loading} />

        <Panel
          title="Needs you"
          count={waiting ? waiting : undefined}
          testId="home-needs"
          tools={
            <>
              {decisions.length > 0 && <CountChip label="Decisions" n={decisions.length} />}
              {reviews.length > 0 && <CountChip label="Reviews" n={reviews.length} />}
              {questions.length > 0 && <CountChip label="Questions" n={questions.length} />}
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
          {actError && (
            <div className="px-4 pt-3">
              <Notice tone="error">{actError}</Notice>
            </div>
          )}
          {inbox && allNeeds.length === 0 && <Empty testId="home-needs-empty">Nothing waiting</Empty>}
          <NeedTable title="Needs you" testId="home-needs-table" rows={allNeeds.slice(0, MAX_NEEDS)} compact />

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
                <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus" className="ml-auto">
                  New PRD
                </LinkButton>
              </div>
            ) : (
              <FlightTable
                rows={flights}
                loading={docsQ.loading || runsQ.loading}
                selected={selected?.key ?? null}
                onSelect={setPicked}
                onActivate={(f) => router.push(f.kind === "prd" ? `/documents/${f.doc.slug}` : `/runs/${f.run.id}`)}
                header={flightHeader}
              />
            )}
          </section>
        </Panel>
      </Split>
    </Page>
  );
}
