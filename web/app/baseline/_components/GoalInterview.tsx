"use client";

import { useRef, useState, type ReactNode } from "react";

import { DiscussionThread, type ComposerHandle } from "@/components/discuss/DiscussionThread";
import { Button, Chip, Icon } from "@/components/ds";
import { InlineError } from "@/components/review/parts";
import { api, unwrap, type EntityOut, type ProposalOut, type Schemas } from "@/lib/api/client";
import { discussionChanges, dismissMeasure, proposeMeasure, type DiscussionChange, type GoalMeasure } from "@/lib/api/goal-interview";
import { useGoalsLevel } from "@/lib/goals-autonomy";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { ACCEPT_LOCKS } from "./common";
import { COMPARISONS, figure, GoalFields, goalDraft, goalPatch, HORIZONS, shortDay, type GoalDraft, type GoalProblem, type PlanningHorizons } from "./goal-fields";

/**
 * B6 Goals interview, in the goal drawer's Discuss view: the missing-field chips, the thread
 * with Oracle's version cards (Propose, Edit, Dismiss; Accept now once proposed) and its
 * quick replies, and the stepper when several vague goals are interviewed in turn.
 */

type Message = Schemas["DiscussionMessageOut"];

/** The fields a person reads as one: a target is its value, unit and comparison. */
const GROUP: Record<string, string> = { metric: "Metric", unit: "Target", comparison: "Target", target: "Target", horizon: "Horizon", owner: "Owner" };
const groups = (missing: readonly string[] | undefined) => [...new Set((missing ?? []).map((k) => GROUP[k] ?? k))];

/** The strip under the header: each field the goal lacked, green once an accepted change settles it. */
function MissingStrip({ asked, goal }: { asked: string[]; goal: EntityOut }) {
  if (asked.length === 0) return null;
  const open = new Set(groups(goal.goal_check?.missing));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-text2" data-testid="missing-strip">
      <span className="font-semibold">Missing:</span>
      {asked.map((label, i) => {
        const settled = !open.has(label);
        return (
          <span key={label} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            <span data-testid="missing-chip" data-settled={settled ? "true" : "false"} className="inline-flex">
              <Chip kind={settled ? "pass" : "warn"} title={settled ? `${label}: settled` : `${label}: still missing`}>
                {settled && <Icon name="check" size={16} />}
                {label}
              </Chip>
            </span>
          </span>
        );
      })}
    </div>
  );
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "Less than 8% of accounts leaving in their first 90 days". */
function statement(p: GoalMeasure): string {
  const c = COMPARISONS.find((x) => x.value === p.comparison);
  const what = c && isNum(p.target) && p.unit ? `${c.label} ${figure(p.target, p.unit)}` : "No target yet";
  if (!p.metric) return what;
  return p.unit === "%" ? `${what} of ${lowerFirst(p.metric)}` : `${what} · ${p.metric}`;
}

/** "Medium (by Jun 30)". */
function horizonText(p: GoalMeasure): string | null {
  const h = HORIZONS.find((x) => x.value === p.horizon)?.label;
  if (!h) return p.due ? `By ${shortDay(p.due)}` : null;
  return p.due ? `${h} (by ${shortDay(p.due)})` : h;
}

/** The [c:n] a rationale cites, and its text without them. */
function sourcesOf(text: string | null): { n: number; text: string } {
  const cited = new Set([...(text ?? "").matchAll(/\[c:(\d{1,4})\]/g)].map((x) => x[1]));
  return { n: cited.size, text: (text ?? "").replace(/\s*\[c:\d{1,4}\]/g, "").trim() };
}

function draftOf(p: GoalMeasure): GoalDraft {
  return goalDraft({ ...p, owner: p.owner_id ?? null });
}

/** The edited fields as a goal_measure payload; a number field that is not a number is the person's to fix. */
function payloadOf(entityId: string, draft: GoalDraft): GoalMeasure | string {
  for (const [label, raw] of [["Value", draft.target], ["Start value", draft.start], ["Weight", draft.weight]]) {
    if (raw.trim() && !Number.isFinite(Number(raw))) return `${label} must be a number.`;
  }
  const attrs = goalPatch(draft, {});
  const { owner, ...rest } = attrs;
  return { ...(rest as Omit<GoalMeasure, "entity_id">), entity_id: entityId, owner_id: (owner as string | undefined) ?? null };
}

/**
 * One version Oracle offered (G3's goal_measure card): "Version 1 · Less than 8% … · Medium
 * (by Jun 30) · 2 sources", the rationale in grey, then Propose, Edit and Dismiss as the reader
 * may; once proposed, Accept now (approvers) or "waiting for an approver".
 */
function VersionCard({
  change,
  n,
  goal,
  open,
  proposal,
  people,
  onChanged,
}: {
  change: DiscussionChange;
  n: number;
  goal: EntityOut;
  /** The discussion is open: the card can be acted on. */
  open: boolean;
  proposal: ProposalOut | undefined;
  people: Map<string, string>;
  onChanged: () => Promise<void>;
}) {
  const { can } = useMe();
  // G3's generic actions (#187): the change's own action and can_* decide below the route's role.
  const action = change.action;
  const canPropose = action?.verb === "Propose" && action.allowed && can("propose_discussion_change", action.allowed);
  const canDismiss = change.can.dismiss && can("dismiss_discussion_change", change.can.dismiss);
  const canAccept = can("accept_proposal");
  const shown = (change.edited_payload ?? change.payload) as GoalMeasure;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GoalDraft>(() => draftOf(shown));
  const [problems, setProblems] = useState<GoalProblem[]>([]);
  const [pushback, setPushback] = useState<string | null>(change.pushback?.reason ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sources = sourcesOf(change.rationale);
  const live = editing ? (typeof payloadOf(goal.id, draft) === "string" ? shown : (payloadOf(goal.id, draft) as GoalMeasure)) : shown;
  const owner = live.owner_id ? people.get(live.owner_id) : undefined;

  const propose = async () => {
    setError(null);
    let payload: GoalMeasure | null = null;
    if (editing) {
      const p = payloadOf(goal.id, draft);
      if (typeof p === "string") return setError(p);
      payload = p;
    }
    setBusy(true);
    try {
      const res = await proposeMeasure(change, payload);
      if (res.kind === "invalid") {
        // Nothing was created: B5's words, on the card, under the field they are about.
        setProblems(res.errors);
        setEditing(true);
      } else if (res.kind === "pushback") {
        setPushback(res.reason);
      } else if (res.kind === "error") {
        setError(res.message);
      } else {
        setProblems([]);
        setPushback(null);
        setEditing(false);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const acceptNow = (id: string) =>
    act(async () => {
      const res = await api.POST("/v1/baseline/proposals/{proposal_id}/accept", { params: { path: { proposal_id: id } } });
      const errors = (res.error as { errors?: GoalProblem[] } | undefined)?.errors;
      if (res.response.status === 422 && Array.isArray(errors)) throw new Error(errors.map((p) => p.message).join(" "));
      await unwrap(Promise.resolve(res));
    });

  const proposalId = change.result_ref?.proposal_id ?? null;
  const proposed = change.status === "done" && !!proposalId;
  const label = `Version ${n}`;
  return (
    <article
      data-testid="version-card"
      data-status={change.status}
      id={`version-${change.id}`}
      tabIndex={-1}
      aria-label={label}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <p className="min-w-0 text-[15px] leading-[22px] break-words" data-testid="version-heading">
        <span className="font-semibold">{label}</span>
        {" · "}
        <span className="font-semibold">{statement(live)}</span>
        {horizonText(live) && <> · {horizonText(live)}</>}
        {sources.n > 0 && <> · {sources.n === 1 ? "1 source" : `${sources.n} sources`}</>}
        {owner && <> · Owner {owner}</>}
      </p>
      {sources.text && (
        <p className="text-sm leading-5 text-text2" data-testid="version-rationale">
          {sources.text}
        </p>
      )}
      {editing && (
        <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-3" data-testid="version-edit">
          <GoalFields
            draft={draft}
            onChange={(d) => {
              setDraft(d);
              setError(null);
            }}
            problems={problems}
            horizons={goal.goal_check?.horizons as PlanningHorizons | null | undefined}
          />
        </div>
      )}
      {pushback && change.status === "proposed" && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn" data-testid="version-pushback">
          <span className="font-semibold">Oracle pushes back</span>
          <span className="text-text">{pushback}</span>
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
      {open && change.status === "proposed" && canPropose && (
        <div className="flex flex-wrap items-center gap-2 max-[600px]:flex-col max-[600px]:items-stretch" data-testid="version-actions">
          <Button variant="solid" disabled={busy} onClick={() => void propose()}>
            {pushback ? "Propose anyway" : "Propose"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setEditing((e) => !e);
              setProblems([]);
              setError(null);
            }}
            aria-expanded={editing}
          >
            {editing ? "Cancel edit" : "Edit"}
          </Button>
          {canDismiss && (
            <Button variant="ghost" disabled={busy} onClick={() => void act(() => dismissMeasure(change))}>
              Dismiss
            </Button>
          )}
        </div>
      )}
      {proposed && (
        <p className="flex flex-wrap items-center gap-2 text-sm max-[600px]:flex-col max-[600px]:items-stretch" data-testid="version-proposed">
          <span className="font-semibold">Proposed</span>
          {proposal?.status === "accepted" ? (
            <span className="text-pass">· Accepted</span>
          ) : proposal?.status === "rejected" ? (
            <span className="text-text2">· Rejected</span>
          ) : canAccept ? (
            <Button variant="solid" disabled={busy || !proposal} title={ACCEPT_LOCKS} onClick={() => void acceptNow(proposalId!)}>
              Accept now
            </Button>
          ) : (
            <span className="text-text2">· waiting for an approver</span>
          )}
        </p>
      )}
      {change.status === "dismissed" && <p className="text-sm text-text2">Dismissed</p>}
    </article>
  );
}

/** "Goal 1 of 2 · Next · Skip": the vague goals interviewed one after another. */
export type Stepper = { at: number; of: number; next?: () => void; skip?: () => void; done: () => void; busy: boolean };

function StepperBar({ s }: { s: Stepper }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-surface2 px-3 py-2 text-sm" data-testid="interview-stepper">
      <span className="font-semibold" data-testid="stepper-position">
        Goal {s.at + 1} of {s.of}
      </span>
      {s.next ? (
        <>
          <span aria-hidden>·</span>
          <Button variant="ghost" disabled={s.busy} onClick={s.next}>
            Next
          </Button>
          <span aria-hidden>·</span>
          <Button variant="ghost" disabled={s.busy} onClick={s.skip} title={`Skip goal ${s.at + 2}: no discussion starts for it`}>
            Skip
          </Button>
        </>
      ) : (
        <>
          <span aria-hidden>·</span>
          <Button variant="ghost" onClick={s.done}>
            Done
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The goal drawer's Discuss view for a goals interview. On a phone it is a full-height
 * sheet over the page; the card buttons stack and stay in view.
 */
export function GoalDiscuss({
  goal,
  discussionId,
  stepper,
  onBack,
  onChanged,
}: {
  goal: EntityOut;
  discussionId: string;
  stepper?: Stepper | null;
  onBack: () => void;
  /** A version was proposed or accepted: the Baseline's lists reload. */
  onChanged: () => void;
}) {
  const changes = useQuery(`discussion-changes:${discussionId}`, () => discussionChanges(discussionId), { keepPrevious: true });
  const proposals = useQuery(`baseline-proposals-all:${discussionId}`, () => unwrap(api.GET("/v1/baseline/proposals")), { keepPrevious: true });
  // H11 Shape goals at Draft: Oracle's one version is the named person's to edit and own (the
  // goal's owner, else who started the interview), so no "Use version 1" default is offered.
  const drafting = useGoalsLevel() === "draft";
  const goalOwner = typeof goal.attrs?.owner === "string" ? goal.attrs.owner : null;
  const ids = [
    ...new Set(
      (changes.data ?? [])
        .flatMap((c) => [c.suggested_by?.user_id, (c.edited_payload ?? c.payload).owner_id])
        .concat(drafting ? [goalOwner] : [])
        .filter((x): x is string => !!x),
    ),
  ];
  const people = useQuery(`people-ids:${ids.sort().join(",")}`, () =>
    ids.length ? unwrap(api.GET("/v1/people", { params: { query: { ids } } })) : Promise.resolve([] as Schemas["PersonOut"][]),
  );
  const names = new Map((people.data ?? []).map((p) => [p.user_id, p.name]));
  // What the goal lacked when the interview opened: the chips tick green as it is settled.
  const [asked] = useState(() => groups(goal.goal_check?.missing));
  const [refresh, setRefresh] = useState(0);
  const composer = useRef<ComposerHandle>(null);
  const versions = (changes.data ?? []).filter((c) => c.kind === "goal_measure");

  const reload = async () => {
    await Promise.all([changes.reload(), proposals.reload()]);
    setRefresh((r) => r + 1);
    onChanged();
  };

  const pickVersion = async (c: DiscussionChange) => {
    await composer.current?.send("Use version 1");
    document.getElementById(`version-${c.id}`)?.focus();
  };

  const renderAfter = (m: Message, ctx: { d: Schemas["DiscussionOut"]; messages: Message[] }) => {
    const oracle = ctx.messages.filter((x) => x.author_kind === "oracle" && !x.deleted);
    if (m.author_kind !== "oracle") return null;
    const first = oracle[0]?.id === m.id;
    const last = oracle.at(-1)?.id === m.id;
    const open = ctx.d.status === "open";
    const v1 = versions[0];
    return (
      <>
        {first && versions.length > 0 && (
          <ol className="mt-2 flex min-w-0 flex-col gap-2" aria-label="Versions">
            {versions.map((c, i) => (
              <li key={c.id} className="min-w-0">
                <VersionCard
                  change={c}
                  n={i + 1}
                  goal={goal}
                  open={open}
                  proposal={(proposals.data ?? []).find((p) => p.id === c.result_ref?.proposal_id)}
                  people={names}
                  onChanged={reload}
                />
              </li>
            ))}
          </ol>
        )}
        {first && drafting && versions.length > 0 && (
          <p className="mt-2 text-sm text-text2" data-testid="goals-draft-note">
            {`Oracle drafted one version for ${goalOwner ? (names.get(goalOwner) ?? "the goal's owner") : ctx.d.started_by.name} to edit and own.`}
          </p>
        )}
        {last && open && ctx.d.me.can_write && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Quick replies" data-testid="quick-replies">
            {v1 && v1.status === "proposed" && !drafting && (
              <li>
                <QuickReply onClick={() => void pickVersion(v1)}>Use version 1</QuickReply>
              </li>
            )}
            <li>
              <QuickReply onClick={() => void composer.current?.send("I don't know")}>I don&apos;t know</QuickReply>
            </li>
            <li>
              <QuickReply onClick={() => composer.current?.mention()}>Ask someone…</QuickReply>
            </li>
          </ul>
        )}
      </>
    );
  };

  return (
    <section
      aria-label="Discuss"
      data-testid="goal-discuss"
      className="flex min-w-0 flex-col gap-3 rounded-inspector border border-line bg-surface p-4 max-[600px]:fixed max-[600px]:inset-0 max-[600px]:z-50 max-[600px]:h-dvh max-[600px]:overflow-x-hidden max-[600px]:overflow-y-auto max-[600px]:overscroll-contain max-[600px]:rounded-none max-[600px]:border-0 max-[600px]:p-3"
    >
      {stepper && <StepperBar s={stepper} />}
      {(changes.error || proposals.error) && <InlineError>{changes.error ?? proposals.error}</InlineError>}
      <DiscussionThread
        key={discussionId}
        id={discussionId}
        onBack={onBack}
        backLabel="Goal details"
        refreshKey={refresh}
        composer={composer}
        onChanged={() => void reload()}
        belowHeader={<MissingStrip asked={asked} goal={goal} />}
        renderAfter={renderAfter}
        inlineKinds={["goal_measure"]}
      />
    </section>
  );
}

function QuickReply({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center rounded-full border border-line-strong bg-surface px-3 text-sm font-semibold text-text hover:bg-surface2"
    >
      {children}
    </button>
  );
}
