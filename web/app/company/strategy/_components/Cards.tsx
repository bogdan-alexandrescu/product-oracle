"use client";

import type { ReactNode } from "react";

import { Button, Chip, LinkButton, Panel } from "@/components/ds";
import { assess, type GoalView } from "@/app/home/_goals";

import { CompanyEmpty } from "../../_empty";
import { BELIEF, DOC, plural, shortDate, type Choice, type DocKind, type DocRef, type Stack } from "./lib";

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

/** What each piece is, in a line. */
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
        {ABOUT[kind]} Open the draft to review it; an owner approves it.
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
      {ABOUT[kind]} {next}
    </Explained>
  );
}

/** The vision: its headline, horizon and beliefs (with their status and evidence). */
export function VisionCard({
  stack,
  doc,
  owner,
  onDraft,
}: {
  stack: Stack | undefined;
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
      ) : (
        <NotApproved kind="vision" doc={doc} owner={owner} />
      )}
      <DocButtons kind="vision" doc={doc} owner={owner} onDraft={onDraft} />
    </Panel>
  );
}

/** A goal as a chip with its distance to go (Home's reading of the baseline). */
function GoalChip({ goal, view }: { goal: { id: string; title: string }; view: GoalView | undefined }) {
  const p = view ? assess(view) : null;
  const togo = p && (p.state === "togo" || p.state === "met") ? p.text : null;
  return (
    <span data-testid="goal-chip" className="inline-flex max-w-full">
      <Chip kind="line" wrap title={view?.metric ?? undefined}>
        {goal.title}
        {togo && <span className="ml-1 font-normal text-text2">· {togo}</span>}
      </Chip>
    </span>
  );
}

function FocusRow({ c, goals }: { c: Choice; goals: Map<string, GoalView> }) {
  return (
    <li data-testid="focus-row" className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{c.title}</span>
        <span className="tnum text-sm text-text2">{plural(c.items, "item")}</span>
        {c.open_findings > 0 ? (
          <Chip kind="warn">{plural(c.open_findings, "finding")}</Chip>
        ) : (
          <span className="text-sm text-text2">No drift</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {c.goals.length ? (
          c.goals.map((g) => <GoalChip key={g.id} goal={g} view={goals.get(g.id)} />)
        ) : (
          <span className="text-sm text-warn">No goal derives from it</span>
        )}
      </div>
    </li>
  );
}

function StopRow({ c }: { c: Choice }) {
  const planned = c.items;
  return (
    <li data-testid="stop-row" className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 font-semibold [overflow-wrap:anywhere]">{c.title}</span>
        <span
          data-testid="stop-planned"
          data-tone={planned > 0 ? "fail" : "pass"}
          className={`tnum text-sm font-semibold ${planned > 0 ? "text-crit" : "text-text2"}`}
        >
          {planned > 0 ? `${plural(planned, "item")} still planned` : "Nothing planned"}
        </span>
      </div>
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
  doc,
  owner,
  goals,
  onDraft,
}: {
  stack: Stack | undefined;
  doc: DocRef | null;
  owner: boolean;
  goals: Map<string, GoalView>;
  onDraft: (kind: DocKind) => void;
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
                  <FocusRow key={c.entity_id} c={c} goals={goals} />
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
                  <StopRow key={c.entity_id} c={c} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text2">Nothing stopped</p>
            )}
          </section>
          <p className="text-sm text-text2">Next review {shortDate(s.review_on)}</p>
        </div>
      ) : (
        <NotApproved kind="strategy" doc={doc} owner={owner} />
      )}
      <DocButtons kind="strategy" doc={doc} owner={owner} onDraft={onDraft} />
    </Panel>
  );
}
