"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Avatar, Block, HomeCard, HomeRow, RowIcon, Top } from "@/app/simple/_home/cards";
import { Walk } from "@/app/simple/_home/walk";
import { toast } from "@/components/ds/Toast";
import { GoalPanel, useGoalSuggestions, type GoalBrief } from "@/components/simple/GoalSuggestions";
import { PlanByMonth } from "@/components/simple/PlanByMonth";
import { SimplePage } from "@/components/simple/SimplePage";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatInZone, useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import {
  beforeAfter,
  brokenLinks,
  goalTiles,
  greeting,
  NEW_FLOW_OPS,
  OP_WORDS,
  planByMonth,
  planInput,
  prdInPlay,
  waitSentence,
  type BrokenLink,
  type GoalTile,
} from "@/lib/simple-home";
import { errorMessage, useQuery } from "@/lib/use-query";
import { invalidateWaiting, loadInbox, waitingChanged } from "@/lib/waiting";

type Change = Schemas["SimpleChangeOut"];
type Decision = Schemas["DecisionOut"];

const STATUS_TONE: Record<GoalTile["status"], string> = {
  "At risk": "simple-status-risk",
  "Not measured yet": "simple-status-quiet",
  "Not counted yet": "simple-status-quiet",
  Planned: "simple-status-ok",
};

/**
 * Simple's Home (#723 S1, the owner's pick "Brief as cards"): the greeting, the goal band, the
 * summary card and one card per section (decisions waiting for me, proposals on my items, the
 * next review meeting, the plan this quarter, since my last visit), each loading and failing on
 * its own. Every action goes through the API with the caller's permissions: decisions through
 * H1's decide, proposals and the broken-link fixes through the change engine (owners and the
 * decider apply with Undo, others propose, viewers read). Roles only through can() and the
 * rows' own can_* fields.
 */
export default function SimpleHome() {
  const { me, can } = useMe();
  const zone = useCompanyZone();
  const [stamp, setStamp] = useState(0);
  // S9: "Walk me through it" turns Home into a guided pass; Done returns here.
  const [walking, setWalking] = useState(false);
  const k = (name: string) => `simple-home|${name}|${stamp}`;
  const reloadAll = () => {
    invalidateWaiting();
    setStamp((s) => s + 1);
    waitingChanged();
  };

  const inbox = useQuery(k("inbox"), loadInbox, { keepPrevious: true });
  const roadmap = useQuery(k("roadmap"), () => unwrap(api.GET("/v1/simple/roadmap")), { keepPrevious: true });
  const goals = useQuery(k("goals"), () => unwrap(api.GET("/v1/baseline/entities", { params: { query: { type: "goal" } } })), { keepPrevious: true });
  const changes = useQuery(k("changes"), () => unwrap(api.GET("/v1/simple/changes")), { keepPrevious: true });
  const drafts = useQuery(k("drafts"), () => unwrap(api.GET("/v1/simple/drafts")), { keepPrevious: true });
  const decisions = useQuery(
    k("decisions"),
    async (): Promise<Decision[]> => {
      const rows = (await loadInbox()).decisions.filter((d) => d.counts && d.reason === "needs_decision");
      return Promise.all(rows.map((d) => unwrap(api.GET("/v1/decisions/{decision}", { params: { path: { decision: String(d.number) } } }))));
    },
    { keepPrevious: true },
  );
  const meeting = useQuery(k("meeting"), async () => {
    const rituals = await unwrap(api.GET("/v1/rituals"));
    const next = rituals.filter((r) => r.status === "active" && r.next_due_at).sort((a, b) => a.next_due_at!.localeCompare(b.next_due_at!))[0];
    return { next: next ?? null };
  });
  const personIds = useMemo(() => {
    const ids = new Set<string>([...(meeting.data?.next?.attendee_ids.slice(0, 4) ?? []), ...(drafts.data ?? []).flatMap((d) => d.waiting_on)]);
    for (const c of changes.data ?? []) if (c.status === "proposed") c.routed_to.forEach((id) => ids.add(id));
    return [...ids].sort();
  }, [meeting.data, drafts.data, changes.data]);
  // keepPrevious: names already read stay while a new id set loads (a toast never reads a gap).
  const people = useQuery(
    k(`people|${personIds.join(",")}`),
    () => (personIds.length ? unwrap(api.GET("/v1/people", { params: { query: { ids: personIds } } })) : Promise.resolve([] as Schemas["PersonOut"][])),
    { keepPrevious: true },
  );
  /** A person by their display name (GET /v1/people), never by an email's local part. */
  const nameOf = (id: string, fallback: string) => people.data?.find((p) => p.user_id === id)?.name ?? fallback;
  const decidedLately = useQuery(k("decided"), () => unwrap(api.GET("/v1/decisions", { params: { query: { status: "decided" } } })));
  const onePagers = useQuery(k("one-pagers"), () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));

  // S7: Oracle's suggested features under each goal of the band (an accept reloads Home).
  const suggestions = useGoalSuggestions(reloadAll);
  const [goalPanel, setGoalPanel] = useState<GoalBrief | null>(null);
  const proposes = can("create_simple_change");
  const decidesAll = can("accept_simple_change");
  const reads = !proposes;
  const myId = me?.user_id ?? "";

  const toDecide = useMemo(() => (changes.data ?? []).filter((c) => c.status === "proposed" && c.can_decide), [changes.data]);
  const mine = useMemo(() => (changes.data ?? []).filter((c) => c.status === "proposed" && c.by === myId), [changes.data, myId]);
  const broken = useMemo(() => brokenLinks(roadmap.data), [roadmap.data]);
  const waitingItems = useMemo(() => {
    const ids = new Set<string>();
    for (const c of toDecide) if (typeof c.target.item_id === "string") ids.add(c.target.item_id);
    for (const b of broken) if (b.item.can_decide) ids.add(b.item.id);
    return ids;
  }, [toDecide, broken]);
  const tiles = useMemo(() => (goals.data ? goalTiles(goals.data, roadmap.data, waitingItems) : undefined), [goals.data, roadmap.data, waitingItems]);
  // The plan this quarter: the PRD in play (the top PRD by priority when several) by month.
  const priorities = useQuery(k("priorities"), () => unwrap(api.GET("/v1/simple/priorities")), { keepPrevious: true });
  const planPrd = useMemo(() => prdInPlay(roadmap.data, (priorities.data?.rows ?? []).map((r) => r.item_id)), [roadmap.data, priorities.data]);
  const plan = useMemo(
    () => (roadmap.data && planPrd ? planByMonth(roadmap.data.items.filter((i) => i.prd?.id === planPrd.id && i.status !== "cut").map(planInput), roadmap.data.today) : null),
    [roadmap.data, planPrd],
  );
  const draft = (drafts.data ?? []).find((d) => d.status === "working" && d.changes > 0 && (d.created_by === myId || d.participant_ids.includes(myId)));
  const proposalRows = toDecide.length > 0 || decidesAll ? toDecide : mine;
  const proposalTitle = toDecide.length > 0 || decidesAll ? "Proposals on your items" : "Your proposals waiting";
  // A decider's own proposals on items others decide wait too: their own card.
  const mineApart = proposalRows === toDecide ? mine : [];
  const itemTitle = (id: unknown) => roadmap.data?.items.find((i) => i.id === id)?.title ?? "An item";

  const now = new Date();
  const hour = Number(formatInZone(now.toISOString(), zone, { hour: "numeric", hourCycle: "h23" }).replace(/\D.*$/, "")) || 9;
  const firstName = (me?.name ?? me?.email ?? "").split(/[\s@]/)[0];
  const decisionCount = decisions.data?.length ?? 0;
  const sentence = reads
    ? "Here is where the plan stands."
    : waitSentence([
        [decisionCount, "decision", "decisions"],
        [proposalRows === toDecide ? toDecide.length : 0, "proposal", "proposals"],
        [broken.filter((b) => b.item.can_decide).length, "broken link", "broken links"],
      ]);

  const proposalRow = (c: Change) => (
    <HomeRow
      key={c.id}
      testId="home-proposal"
      lead={<Avatar name={c.by_name} />}
      title={`${OP_WORDS[c.op] ?? c.op}: ${itemTitle(c.target.item_id)}${typeof c.after.title === "string" && NEW_FLOW_OPS.has(c.op) ? ` · ${c.after.title}` : ""}`}
      meta={`${c.by === myId ? "You" : c.by_name} · ${formatInZone(c.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${c.reason ? ` · ${c.reason}` : ""}`}
      change={NEW_FLOW_OPS.has(c.op) ? null : beforeAfter(c)}
      thumb={NEW_FLOW_OPS.has(c.op)}
      actions={
        c.can_decide ? (
          <>
            <button
              type="button"
              className="simple-button simple-button-primary"
              onClick={() => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/accept", { params: { path: { change_id: c.id } } })), "Accepted")}
            >
              Accept
            </button>
            <button
              type="button"
              className="simple-button"
              onClick={() => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/decline", { params: { path: { change_id: c.id } } })), "Declined")}
            >
              Decline
            </button>
          </>
        ) : (
          <span className="simple-small">Waiting for {c.routed_to.length ? c.routed_to.map((id) => nameOf(id, "the decider")).join(", ") : "the decider"}</span>
        )
      }
    />
  );

  async function act(run: () => Promise<unknown>, done: string) {
    try {
      await run();
      toast({ message: done });
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    reloadAll();
  }

  async function changeResult(r: { change: Change }, applied: string) {
    const c = r.change;
    if (c.status === "proposed") {
      // Who it waits on may be someone this page has not named yet: read them first.
      const unknown = c.routed_to.filter((id) => !people.data?.some((p) => p.user_id === id));
      const more = unknown.length ? await unwrap(api.GET("/v1/people", { params: { query: { ids: unknown } } })).catch(() => []) : [];
      const who = c.routed_to.map((id) => more.find((p) => p.user_id === id)?.name ?? nameOf(id, "the decider"));
      return `Proposed: ${who.length ? who.join(", ") : "the decider"} ${who.length > 1 ? "decide" : "decides"}`;
    }
    return applied;
  }

  async function fix(b: BrokenLink, op: "shift_dependents" | "move_dependency" | "accept_risk", note = "") {
    const dep = b.dependency;
    const body: Schemas["SimpleChangeIn"] =
      op === "accept_risk"
        ? { op, target: { item_id: b.item.id, flag: b.flag.kind, subject: b.flag.subject }, before: { risk: null }, after: { risk: { note: note.trim() } } }
        : {
            op,
            target: { item_id: b.item.id, subject: b.flag.subject },
            before: { [b.item.id]: stored(b.item), ...(dep ? { [dep.id]: stored(dep) } : {}) },
          };
    try {
      const r = await unwrap(api.POST("/v1/simple/changes", { body }));
      const message = await changeResult(r, `${OP_WORDS[op]}: applied to your working draft`);
      const id = r.change.status === "applied" && r.change.can_undo ? r.change.id : null;
      toast(
        id
          ? { message, action: { label: "Undo", onClick: () => void act(() => unwrap(api.POST("/v1/simple/changes/{change_id}/undo", { params: { path: { change_id: id } } })), "Undone") } }
          : { message },
      );
    } catch (e) {
      toast({ message: errorMessage(e) });
    }
    reloadAll();
  }

  function decide(d: Decision, key: string) {
    const option = d.options.find((o) => o.key === key)!;
    void act(
      () =>
        unwrap(
          api.POST("/v1/decisions/{decision}/decide", {
            params: { path: { decision: String(d.number) } },
            body: { option_key: key, rationale: `Decided on Simple's Home: ${option.label}`, expected_outcome: option.summary || option.label, lock_version: d.lock_version },
          }),
        ),
      `Decided: ${option.label}`,
    );
  }

  return (
    <SimplePage title="Home">
      {goalPanel && <GoalPanel goal={goalPanel} api={suggestions} onClose={() => setGoalPanel(null)} />}
      <header data-testid="home-greeting" className="-mt-4 flex flex-col gap-1">
        <p className="simple-small tnum">{formatInZone(now.toISOString(), zone, { weekday: "long", month: "long", day: "numeric" })}</p>
        <p className="simple-lead">
          {greeting(hour)}
          {firstName ? `, ${firstName}` : ""}. <span data-testid="home-sentence">{sentence}</span>
        </p>
        {!walking && !reads && (
          <div>
            <button type="button" className="simple-button simple-button-primary" onClick={() => setWalking(true)}>
              Walk me through it
            </button>
          </div>
        )}
      </header>

      {walking && (
        <Walk
          onDone={() => {
            setWalking(false);
            reloadAll();
          }}
        />
      )}

      {!walking && (
      <>

      {(roadmap.data?.changes_in_review ?? 0) > 0 && (
        <p role="status" data-testid="home-in-review" className="rounded-xl bg-warn-bg px-4 py-3 text-warn">
          {roadmap.data!.changes_in_review} {roadmap.data!.changes_in_review === 1 ? "change is" : "changes are"} in review. You see the published plan until they are approved.
        </p>
      )}

      <section aria-label="Goals" data-testid="home-goals">
        <Block q={{ ...goals, data: tiles }} testId="home-goals">
          {(rows) =>
            rows.length === 0 ? (
              <p className="simple-small" data-testid="home-goals-empty">
                No confirmed company goals yet.
              </p>
            ) : (
              <ul className="simple-goal-band">
                {rows.map((g) => (
                  <li key={g.id} data-testid="home-goal" className="simple-goal">
                    <div className="flex items-center gap-2">
                      <span className="simple-code">{g.code}</span>
                      {g.guardrail && <span className="simple-tag">guardrail</span>}
                      {g.weight != null && <span className="simple-small ml-auto tnum">weight {g.weight}</span>}
                    </div>
                    <span className="font-semibold">{g.name}</span>
                    {g.path && (
                      <span data-testid="home-goal-path" className="simple-small tnum">
                        {g.path}
                      </span>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-2">
                      <span data-testid="home-goal-status" title={g.why ?? undefined} className={`simple-status ${STATUS_TONE[g.status]}`}>
                        {g.status}
                      </span>
                      {!reads && g.needYou > 0 && (
                        <span className="simple-small" data-testid="home-goal-need">
                          {g.needYou} {g.needYou === 1 ? "item needs" : "items need"} you
                        </span>
                      )}
                    </div>
                    {(() => {
                      const known = suggestions.data?.goals.find((x) => x.goal.id === g.id);
                      if (!known) return null;
                      const n = (suggestions.data?.suggestions ?? []).filter((x) => x.goal.id === g.id).length;
                      return (
                        <button type="button" data-testid="home-goal-suggestions" onClick={() => setGoalPanel(known.goal)} className="simple-small self-start font-semibold text-accent-ink hover:underline">
                          {n ? `✦ ${n} suggested ${n === 1 ? "feature" : "features"}` : proposes ? "✦ Suggest features" : "✦ No suggested features"}
                          {known.pending && " · Oracle is suggesting…"}
                        </button>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            )
          }
        </Block>
      </section>

      {!reads && (
        <section aria-label="Summary" data-testid="home-summary" className="simple-card">
          <ul className="grid grid-cols-3 gap-3 max-[600px]:grid-cols-1">
            {[
              ["decisions", decisions.data ? decisionCount : null, "decisions waiting for you"],
              ["proposals", changes.data ? proposalRows.length : null, proposalRows === toDecide ? "proposals on your items" : "of your proposals waiting"],
              ["broken-links", roadmap.data ? broken.length : null, "broken links"],
            ].map(([id, n, label]) => (
              <li key={id as string}>
                <a href={`#${id}`} data-testid={`home-summary-${id}`} className="flex flex-col rounded-xl bg-surface2 px-4 py-3 hover:bg-accent-soft">
                  <span className="simple-number tnum">{n ?? "–"}</span>
                  <span className="simple-small">{label}</span>
                </a>
              </li>
            ))}
          </ul>
          {draft && (
            <p data-testid="home-draft" className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Your working draft of <strong>{draft.document.title}</strong> has {draft.changes} {draft.changes === 1 ? "change" : "changes"}. It publishes as v
                {(draft.base_version ?? 0) + 1} when{" "}
                {draft.waiting_on.length
                  ? draft.waiting_on.map((id) => nameOf(id, "a reviewer")).join(", ")
                  : "its decider"}{" "}
                {draft.waiting_on.length > 1 ? "approve" : "approves"}.
              </span>
              <Link href={`/simple/roadmap?draft=${draft.id}`} className="simple-button">
                Open draft
              </Link>
            </p>
          )}
        </section>
      )}

      {!reads && (
        <HomeCard id="decisions" icon="flag" title="Decisions waiting for you" count={decisions.data?.length} all="/simple/decisions">
          <Block q={decisions} testId="home-decisions">
            {(rows) =>
              rows.length === 0 ? (
                <p className="simple-small" data-testid="home-decisions-empty">
                  No decision waits on you.
                </p>
              ) : (
                <Top rows={rows} more="/simple/decisions">
                  {(d) => <DecisionRow key={d.id} d={d} onDecide={decide} />}
                </Top>
              )
            }
          </Block>
        </HomeCard>
      )}

      {!reads && (
        <HomeCard id="proposals" icon="comment" title={proposalTitle} count={changes.data ? proposalRows.length : null} all="/simple/roadmap">
          <Block q={changes} testId="home-proposals">
            {() =>
              proposalRows.length === 0 ? (
                <p className="simple-small" data-testid="home-proposals-empty">
                  {proposalRows === toDecide ? "No proposals on your items." : "None of your proposals waits."}
                </p>
              ) : (
                <Top rows={proposalRows} more="/simple/roadmap">
                  {proposalRow}
                </Top>
              )
            }
          </Block>
        </HomeCard>
      )}

      {!reads && mineApart.length > 0 && (
        <HomeCard id="my-proposals" icon="comment" title="Your proposals waiting" count={mineApart.length} all="/simple/roadmap">
          <Block q={changes} testId="home-my-proposals">
            {() => (
              <Top rows={mineApart} more="/simple/roadmap">
                {proposalRow}
              </Top>
            )}
          </Block>
        </HomeCard>
      )}

      <HomeCard id="meeting" icon="clock" title="Next review meeting" all="/simple/meetings">
        <Block q={meeting} testId="home-meeting">
          {({ next }) =>
            !next ? (
              <p className="simple-small" data-testid="home-meeting-empty">
                No review meeting scheduled.
              </p>
            ) : (
              <ul className="flex flex-col">
                <HomeRow
                  testId="home-meeting-next"
                  lead={
                    <span className="simple-date-tile tnum" aria-hidden>
                      <span>{formatInZone(next.next_due_at!, zone, { month: "short" })}</span>
                      <strong>{formatInZone(next.next_due_at!, zone, { day: "numeric" })}</strong>
                    </span>
                  }
                  title={next.title}
                  meta={
                    <>
                      <span className="tnum">
                        {formatInZone(next.next_due_at!, zone, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} · {next.duration_min} min
                      </span>
                      <br />
                      {next.attendee_ids.length} {next.attendee_ids.length === 1 ? "attendee" : "attendees"}
                      {next.attendee_ids.length > 0 &&
                        `: ${next.attendee_ids
                          .slice(0, 4)
                          .map((id) => nameOf(id, "someone"))
                          .join(", ")}`}
                    </>
                  }
                  actions={
                    <>
                      {(next.owner_id === myId || can("update_ritual")) && (
                        <Link href={`/simple/meetings/${next.id}?start=1`} className="simple-button simple-button-primary">
                          Start meeting
                        </Link>
                      )}
                      {next.last_pre_read ? (
                        <Link href={`/simple/meetings/${next.id}?pre_read=${next.last_pre_read.id}`} className="simple-button">
                          Open pre-read
                        </Link>
                      ) : (
                        <span className="simple-small">Pre-read not ready yet</span>
                      )}
                    </>
                  }
                />
              </ul>
            )
          }
        </Block>
      </HomeCard>

      <HomeCard id="plan" icon="roadmap" title="The plan this quarter" all="/simple/roadmap">
        <Block q={roadmap} testId="home-plan">
          {() => (
            <>
              {plan && planPrd ? (
                <PlanByMonth plan={plan} prd={planPrd} testId="home-strip" />
              ) : (
                <p className="simple-small" data-testid="home-plan-empty">
                  Nothing planned this quarter yet.
                </p>
              )}
              {broken.length > 0 && (
                <div id="broken-links" className="scroll-mt-6">
                  <Top rows={broken} more="/simple/roadmap">
                    {(b) => (
                      <BrokenRow key={`${b.item.id}-${b.flag.subject}`} b={b} reads={reads} onFix={fix} />
                    )}
                  </Top>
                </div>
              )}
            </>
          )}
        </Block>
      </HomeCard>

      {reads ? (
        <>
          <HomeCard id="next-milestone" icon="flag" title="What the next milestone delivers" all="/simple/roadmap">
            <Block q={roadmap} testId="home-milestone">
              {(r) => {
                const m = r.milestones.filter((x) => x.date && x.date >= r.today && x.status === "planned").sort((a, b) => a.date!.localeCompare(b.date!))[0];
                if (!m) return <p className="simple-small">No milestone ahead yet.</p>;
                return (
                  <Top rows={r.items.filter((i) => m.item_ids.includes(i.id))} more="/simple/roadmap">
                    {(i) => <HomeRow key={i.id} lead={<RowIcon name="roadmap" />} title={i.title} meta={`${m.name} · ${i.outcome ?? i.roadmap.title}`} />}
                  </Top>
                );
              }}
            </Block>
          </HomeCard>
          <HomeCard id="decided" icon="check" title="Decided lately" all="/simple/decisions">
            <Block q={decidedLately} testId="home-decided">
              {(rows) =>
                rows.length === 0 ? (
                  <p className="simple-small">Nothing decided yet.</p>
                ) : (
                  <Top rows={rows} more="/simple/decisions">
                    {(d) => (
                      <HomeRow
                        key={d.id}
                        testId="home-decided-row"
                        lead={<RowIcon name="check" />}
                        title={d.title}
                        meta={d.decided_at ? formatInZone(d.decided_at, zone, { month: "short", day: "numeric" }) : undefined}
                      />
                    )}
                  </Top>
                )
              }
            </Block>
          </HomeCard>
          <HomeCard id="read" icon="doc" title="One-pagers to read" all="/simple/one-pagers">
            <Block q={onePagers} testId="home-read">
              {(rows) =>
                rows.length === 0 ? (
                  <p className="simple-small">No PRDs yet.</p>
                ) : (
                  <Top rows={rows} more="/simple/one-pagers">
                    {(d) => <HomeRow key={d.id} lead={<RowIcon name="doc" />} title={<Link href={`/simple/one-pagers/${d.slug}`} className="hover:underline">{d.title}</Link>} />}
                  </Top>
                )
              }
            </Block>
          </HomeCard>
        </>
      ) : (
        <HomeCard id="since" icon="clock" title="Since your last visit">
          <Block q={{ ...changes, error: changes.error ?? inbox.error, data: inbox.data && changes.data }} testId="home-since">
            {(rows) => {
              const seen = inbox.data?.last_seen_at ?? null;
              const recent = [
                ...rows
                  .filter((c) => c.status !== "proposed" && (!seen || (c.decided_at ?? c.at) > seen))
                  .map((c) => ({ key: c.id, at: c.decided_at ?? c.at, icon: "roadmap" as const, title: `${OP_WORDS[c.op] ?? c.op}: ${itemTitle(c.target.item_id)}`, who: c.by_name, status: c.status })),
                ...(inbox.data?.decisions ?? [])
                  .filter((d) => (d.reason === "oracle_decided" || d.reason === "informed") && (!seen || d.since > seen))
                  .map((d) => ({ key: d.id, at: d.since, icon: "flag" as const, title: d.title, who: "Decision", status: "decided" })),
              ].sort((a, b) => b.at.localeCompare(a.at));
              return recent.length === 0 ? (
                <p className="simple-small" data-testid="home-since-empty">
                  Nothing changed since your last visit.
                </p>
              ) : (
                <Top rows={recent} max={5} more="/simple/decisions">
                  {(r) => (
                    <HomeRow
                      key={r.key}
                      testId="home-since-row"
                      lead={<RowIcon name={r.icon} />}
                      title={r.title}
                      meta={`${r.who} · ${r.status} · ${formatInZone(r.at, zone, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                    />
                  )}
                </Top>
              );
            }}
          </Block>
        </HomeCard>
      )}
      </>
      )}
    </SimplePage>
  );
}

/** The dates an item stores (typed or accepted), as the change engine compares them; null for the others. */
function stored(i: Schemas["SimpleRoadmapItem"]) {
  const own = (d: Schemas["SimpleDate"]) => (d.source === "typed" || d.source === "accepted" ? d.date : null);
  return { start_date: own(i.start), end_date: own(i.end) };
}

/** A decision waiting for me: Decide with the proposed option, or choose another. */
function DecisionRow({ d, onDecide }: { d: Decision; onDecide: (d: Decision, key: string) => void }) {
  const [other, setOther] = useState(false);
  const proposed = d.options.find((o) => o.recommended) ?? d.options[0];
  return (
    <HomeRow
      testId="home-decision"
      lead={<RowIcon name="flag" />}
      title={d.title}
      meta={
        <>
          {d.ref}
          {d.question ? ` · ${d.question}` : ""}
          {proposed ? ` · Proposed: ${proposed.label}` : ""}
          {other && (
            <span role="group" aria-label="Other options" className="mt-2 flex flex-wrap gap-2">
              {d.options
                .filter((o) => o.key !== proposed?.key)
                .map((o) => (
                  <button key={o.key} type="button" className="simple-button" onClick={() => onDecide(d, o.key)}>
                    {o.label}
                  </button>
                ))}
            </span>
          )}
        </>
      }
      actions={
        d.can_decide !== false && proposed && d.options.length >= 2 ? (
          <>
            <button type="button" className="simple-button simple-button-primary" onClick={() => onDecide(d, proposed.key)}>
              Decide: {proposed.label}
            </button>
            <button type="button" className="simple-button" aria-expanded={other} onClick={() => setOther((o) => !o)}>
              Choose another option
            </button>
          </>
        ) : (
          <Link href={`/company/decisions?d=${d.number}`} className="simple-button">
            Open
          </Link>
        )
      }
    />
  );
}

/** A broken dependency: the item in red, its one-line reason, and its one-click fixes (proposals for those who propose). */
function BrokenRow({
  b,
  reads,
  onFix,
}: {
  b: BrokenLink;
  reads: boolean;
  onFix: (b: BrokenLink, op: "shift_dependents" | "move_dependency" | "accept_risk", note?: string) => Promise<void>;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  // The item says whether I decide it and who does (D-a), as a change's can_decide.
  const applies = b.item.can_decide;
  const deciders = b.item.deciders.length ? b.item.deciders.join(", ") : "The decider";
  const label = (text: string) => (applies ? text : `Propose: ${text}`);
  return (
    <HomeRow
      testId="home-broken"
      lead={<RowIcon name="alert" />}
      title={<span className="text-crit">{b.item.title}</span>}
      meta={
        <>
          {b.flag.reason}
          {noting && (
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) void onFix(b, "accept_risk", note.trim());
              }}
            >
              <input
                aria-label="Why the risk is acceptable"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why it is acceptable, in one line"
                className="h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-text"
              />
              <button type="submit" className="simple-button simple-button-primary" disabled={!note.trim()}>
                {applies ? "Accept the risk" : "Propose"}
              </button>
            </form>
          )}
        </>
      }
      actions={
        reads ? undefined : (
          <>
            {!applies && <span className="simple-small">{`${deciders} ${b.item.deciders.length > 1 ? "decide" : "decides"}`}</span>}
            {b.flag.fixes.includes("shift_dependents") && (
              <button type="button" className="simple-button" onClick={() => void onFix(b, "shift_dependents")}>
                {label("Move dependents")}
              </button>
            )}
            {b.flag.fixes.includes("move_dependency") && (
              <button type="button" className="simple-button" onClick={() => void onFix(b, "move_dependency")}>
                {label("Move dependency")}
              </button>
            )}
            {b.flag.fixes.includes("accept_risk") && (
              <button type="button" className="simple-button" aria-expanded={noting} onClick={() => setNoting((n) => !n)}>
                {label("Accept as risk")}
              </button>
            )}
          </>
        )
      }
    />
  );
}
