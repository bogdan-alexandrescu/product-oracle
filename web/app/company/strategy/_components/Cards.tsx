"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button, Chip, InfoTip, LinkButton, Panel } from "@/components/ds";
import { assess, type GoalView } from "@/app/home/_goals";

import { CompanyEmpty } from "../../_empty";
import { BELIEF, DOC, findingsAbout, plural, shortDate, subjectName, type Choice, type DocKind, type DocRef, type Finding, type Stack } from "./lib";

/** The card's footer of document buttons: Open, and for owners New (none yet) or Draft next version; none when neither. */
function DocButtons({
  kind,
  doc,
  owner,
  onDraft,
}: {
  kind: DocKind;
  doc: DocRef | null;
  owner: boolean;
  onDraft: (kind: DocKind) => void;
}) {
  const open = kind === "vision" ? "Open vision" : "Open strategy";
  // qa-company-22: no footer bar at all when there is nothing to open and no New button.
  if (!doc && !owner) return null;
  return (
    <div data-testid={`${kind}-actions`} className="mt-auto flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
      {doc && (
        <LinkButton href={`/documents/${doc.slug}`} variant="secondary">
          {open}
        </LinkButton>
      )}
      {owner && (
        <Button variant={doc ? "ghost" : "primary"} icon={doc ? undefined : "plus"} onClick={() => onDraft(kind)}>
          {doc ? "Draft next version" : kind === "vision" ? "New vision" : "New product strategy"}
        </Button>
      )}
    </div>
  );
}

/** An empty state that says what the piece is and what to do (qa-company-36). */
export function Explained({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <CompanyEmpty testId={testId} title={title}>
      {children}
    </CompanyEmpty>
  );
}

/** What each piece is, behind the empty state's (i) (pass F F-45). */
const ABOUT: Record<DocKind, string> = {
  vision: "Where the company is headed in the next few years, and the beliefs that bet rests on.",
  strategy: "The few things the product focuses on and what it stops doing; each goal should follow from a focus choice.",
};

/** A vision or strategy in progress with nothing approved yet, or nothing at all. */
function NotApproved({ kind, doc, owner }: { kind: DocKind; doc: DocRef | null; owner: boolean }) {
  const name = DOC[kind].name;
  if (doc) {
    return (
      <Explained testId={`${kind}-empty`} title={`The ${name} is not approved yet`}>
        {/* D-11: no visible instruction; the (i) and the card's action only. */}
        <InfoTip label={`the ${name}`} align="end">
          Open the draft to review it. {ABOUT[kind]} An owner approves it.
        </InfoTip>
      </Explained>
    );
  }
  const next =
    kind === "vision"
      ? owner
        ? "Write a vision to start the strategy stack."
        : "An owner writes it to start the strategy stack."
      : owner
        ? "Write a product strategy to line up the goals under it."
        : "An owner writes it to line up the goals under it.";
  return (
    <Explained testId={`${kind}-empty`} title={`No ${name} yet`}>
      <InfoTip label={`the ${name}`} align="end">
        {next} {ABOUT[kind]}
      </InfoTip>
    </Explained>
  );
}

/** The stack's state while it is not in: loading (a skeleton) or failed (pass F F-13). */
export type StackLoad = { loading: boolean; failed: boolean; onRetry: () => void };

/** A card's body until the stack answers: a skeleton, or "Could not load the strategy" with Try again; never "not approved". */
export function StackPending({ load, testId }: { load: StackLoad; testId: string }) {
  if (load.failed)
    return (
      <div data-testid={`${testId}-failed`} className="flex flex-col items-center gap-2 px-4 py-8 text-center max-[600px]:px-3">
        <p className="text-[15px] font-semibold text-text">Could not load the strategy</p>
        <Button onClick={load.onRetry} disabled={load.loading}>
          Try again
        </Button>
      </div>
    );
  return (
    <div data-testid={`${testId}-loading`} aria-busy="true" aria-label="Loading" className="flex flex-col gap-2.5 px-4 py-4 max-[600px]:px-3">
      <span className="h-5 w-3/4 animate-pulse rounded bg-surface2" />
      <span className="h-3.5 w-1/2 animate-pulse rounded bg-surface2" />
      <span className="h-3.5 w-5/6 animate-pulse rounded bg-surface2" />
    </div>
  );
}

/** The vision: its headline, horizon and beliefs (with their status and evidence). */
export function VisionCard({
  stack,
  load,
  doc,
  owner,
  onDraft,
}: {
  stack: Stack | undefined;
  load: StackLoad;
  doc: DocRef | null;
  owner: boolean;
  onDraft: (kind: DocKind) => void;
}) {
  const v = stack?.vision ?? null;
  return (
    <Panel
      title="Vision"
      testId="vision-card"
      className="flex flex-col"
      tools={v && <Chip kind="line">v{v.document.version}</Chip>}
    >
      {v ? (
        <div className="flex flex-col gap-3 px-4 py-3 max-[600px]:px-3">
          {v.headline && <p className="font-display text-xl leading-7 font-bold tracking-heading [overflow-wrap:anywhere]">{v.headline}</p>}
          <p className="text-sm text-text2">
            {v.horizon_years != null && <span>{plural(v.horizon_years, "year")} ahead · </span>}
            Review {shortDate(v.review_on)}
          </p>
          <ul className="flex flex-col">
            {v.beliefs.map((b) => (
              <li
                key={b.id}
                data-testid="vision-belief"
                data-status={b.status}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{b.statement}</span>
                <Chip kind={BELIEF[b.status].kind} dot>
                  {BELIEF[b.status].label}
                </Chip>
                <span className="tnum text-sm text-text2">{b.evidence} evidence</span>
              </li>
            ))}
          </ul>
        </div>
      ) : !stack ? (
        <StackPending load={load} testId="vision" />
      ) : (
        <NotApproved kind="vision" doc={doc} owner={owner} />
      )}
      <DocButtons kind="vision" doc={doc} owner={owner} onDraft={onDraft} />
    </Panel>
  );
}

/** A goal as a chip with its distance to go (Home's reading of the baseline). */
function GoalChip({ goal, view, onClick }: { goal: { id: string; title: string }; view: GoalView | undefined; onClick: () => void }) {
  const p = view ? assess(view) : null;
  const togo = p && (p.state === "togo" || p.state === "met") ? p.text : null;
  return (
    <button type="button" data-testid="goal-chip" className="inline-flex max-w-full rounded-full text-left hover:opacity-80" onClick={onClick}>
      <Chip kind="line" wrap title={view?.metric ?? undefined}>
        {goal.title}
        {togo && <span className="ml-1 font-normal text-text2">· {togo}</span>}
      </Chip>
    </button>
  );
}

/** A count on the card that opens the stack line it counts (pass F F-42). */
const COUNT_LINK = "tnum text-sm text-accent-ink hover:underline";

function FocusRow({ c, goals, canAddGoal, onPick }: { c: Choice; goals: Map<string, GoalView>; canAddGoal: boolean; onPick: (key: string) => void }) {
  // The choice's first stack line: itself when no goal derives from it, else its first goal's.
  const line = c.goals.length ? `${c.entity_id}|${c.goals[0].id}` : c.entity_id;
  return (
    <li data-testid="focus-row" className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{c.title}</span>
        <button type="button" className={COUNT_LINK} onClick={() => onPick(line)}>
          {plural(c.items, "item")}
        </button>
        {c.open_findings > 0 ? (
          <button type="button" onClick={() => onPick(line)}>
            <Chip kind="warn">{plural(c.open_findings, "finding")}</Chip>
          </button>
        ) : (
          <span className="text-sm text-text2">No drift</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {c.goals.length ? (
          c.goals.map((g) => <GoalChip key={g.id} goal={g} view={goals.get(g.id)} onClick={() => onPick(`${c.entity_id}|${g.id}`)} />)
        ) : (
          <>
            <span className="text-sm text-warn">No goal derives from it</span>
            {canAddGoal && (
              <Link href="/baseline?add=goal" className="text-sm font-medium text-accent-ink hover:underline">
                Add a goal
              </Link>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function StopRow({ c, open }: { c: Choice; open: Finding[] }) {
  const planned = c.items;
  const [shown, setShown] = useState(false);
  // The planned items, by their findings (each names the stop choices it is planned against).
  const items = findingsAbout(open, c.entity_id).filter((f) => f.kind === "stopped_but_planned" && f.subject_kind === "roadmap_item");
  return (
    <li data-testid="stop-row" className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{c.title}</span>
        {planned > 0 ? (
          // pass F F-42: the count opens the items it counts, each on the Plan, where it is moved or dropped.
          <button
            type="button"
            data-testid="stop-planned"
            data-tone="fail"
            aria-expanded={shown}
            onClick={() => setShown((v) => !v)}
            className="tnum cursor-pointer text-sm font-semibold text-crit hover:underline"
          >
            {plural(planned, "item")} still planned
          </button>
        ) : (
          <span data-testid="stop-planned" data-tone="pass" className="tnum text-sm font-semibold text-text2">
            Nothing planned
          </span>
        )}
      </div>
      {shown && planned > 0 && (
        <ul data-testid="stop-items" className="flex flex-col gap-1 text-sm">
          {items.map((f) => (
            <li key={f.id}>
              <Link href={`/plan?item=${encodeURIComponent(f.subject_ref)}`} className="font-medium text-accent-ink hover:underline [overflow-wrap:anywhere]">
                {subjectName(f, undefined)}
              </Link>
            </li>
          ))}
          {items.length < planned && (
            <li>
              <Link href="/plan" className="font-medium text-accent-ink hover:underline">
                {items.length ? "The rest on the Plan" : "Open the Plan"}
              </Link>
            </li>
          )}
        </ul>
      )}
      {c.features.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.features.map((f) => (
            <Chip key={f.id} kind="na" wrap>
              {f.title}
            </Chip>
          ))}
        </div>
      )}
    </li>
  );
}

/** The product strategy: its summary, focus and stop choices, and the next review. */
export function StrategyCard({
  stack,
  load,
  doc,
  owner,
  goals,
  canAddGoal,
  onPick,
  onDraft,
  open,
}: {
  stack: Stack | undefined;
  load: StackLoad;
  doc: DocRef | null;
  owner: boolean;
  goals: Map<string, GoalView>;
  /** May add a goal (the Baseline's Add goal), offered where a focus choice has none. */
  canAddGoal: boolean;
  /** Opens the stack line with this key (pass F F-42). */
  onPick: (key: string) => void;
  onDraft: (kind: DocKind) => void;
  /** The open findings: a stop choice's planned items are named by theirs. */
  open: Finding[];
}) {
  const s = stack?.strategy ?? null;
  const focus = s?.choices.filter((c) => c.stance === "focus") ?? [];
  const stop = s?.choices.filter((c) => c.stance === "stop") ?? [];
  return (
    <Panel
      title="Product strategy"
      testId="strategy-card"
      className="flex flex-col"
      tools={s && <Chip kind="line">v{s.document.version}</Chip>}
    >
      {s ? (
        <div className="flex flex-col gap-3 px-4 py-3 max-[600px]:px-3">
          {s.summary && <p className="[overflow-wrap:anywhere]">{s.summary}</p>}
          <section aria-label="Focus">
            <h3 className="mb-1 text-sm font-semibold text-text2">Focus</h3>
            {focus.length ? (
              <ul>
                {focus.map((c) => (
                  <FocusRow key={c.entity_id} c={c} goals={goals} canAddGoal={canAddGoal} onPick={onPick} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">No focus choices</p>
            )}
          </section>
          <section aria-label="Stop">
            <h3 className="mb-1 text-sm font-semibold text-text2">What we stop</h3>
            {stop.length ? (
              <ul>
                {stop.map((c) => (
                  <StopRow key={c.entity_id} c={c} open={open} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">Nothing stopped</p>
            )}
          </section>
          <p className="text-sm text-text2">Next review {shortDate(s.review_on)}</p>
        </div>
      ) : !stack ? (
        <StackPending load={load} testId="strategy" />
      ) : (
        <NotApproved kind="strategy" doc={doc} owner={owner} />
      )}
      <DocButtons kind="strategy" doc={doc} owner={owner} onDraft={onDraft} />
    </Panel>
  );
}
