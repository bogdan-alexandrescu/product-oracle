"use client";

import { Chip, CodeChip, InfoTip, LinkButton, Notice, Panel, Ring, Sparkline, ToGo } from "@/components/ds";
import { namedText } from "@/lib/codes";
import { percent } from "@/lib/goal-tree";

import { amount, assess, formatFigure, shownGoals, spanMonths, type GoalView, type Point } from "./_goals";

/** One goal: id and title, current over target, confidence ring, trend when there is history, distance to go. */
function GoalCard({ g, subs, history }: { g: GoalView; subs: GoalView[]; history: Point[] | undefined }) {
  const trend = history && history.length >= 2 ? history : null;
  const change = trend ? Math.round((trend.at(-1)!.value - trend[0].value) * 10) / 10 : null;
  const p = assess(g, history);
  return (
    <li
      data-testid={`home-goal-${g.tag}`}
      data-proposed={g.proposed || undefined}
      data-state={p.state}
      className="flex min-w-0 flex-col gap-2 border-line px-4 pt-3.5 pb-3 max-[600px]:px-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex min-w-0 flex-1 font-semibold">
          <CodeChip kind="goal" entityId={g.id} title={g.title} code={g.code} proposed={g.proposed} wrap />
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0" data-testid="goal-figure">
          {p.state === "none" || (p.state === "notarget" && !g.currentText) ? (
            <b className="tnum font-display text-[34px] leading-9 font-bold text-text2" aria-label="No current value">
              –
            </b>
          ) : p.state === "raw" || (p.state === "notarget" && !g.current) ? (
            // Units that do not match, or a side Home cannot read: both as written, no distance.
            <b className="tnum font-display text-2xl leading-9 font-bold break-words" title={g.currentText!}>
              {g.currentText}
            </b>
          ) : (
            <b className="tnum font-display text-[34px] leading-9 font-bold tracking-[-0.03em]">{formatFigure(g.current!)}</b>
          )}
          {g.targetText && (
            <span className="tnum ml-1 text-[15px] font-medium text-text2 max-[600px]:ml-0 max-[600px]:block">/ {g.targetText}</span>
          )}
        </span>
        <Ring value={g.confidence} size={44} label={g.confidence == null ? "No confidence" : `Confidence ${g.confidence}`} />
      </div>
      {trend && (
        <div className="min-w-0 [&>svg]:h-auto [&>svg]:w-full" data-testid="goal-trend">
          <Sparkline
            values={trend.map((p) => p.value)}
            target={p.state === "raw" ? undefined : g.target?.value}
            width={240}
            height={40}
            label={`${namedText(g)} trend`}
          />
        </div>
      )}
      <div className="mt-auto flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-[15px]">
        <span data-testid="goal-to-go">
          {p.state === "togo" ? (
            <ToGo amount={p.amount!} unit={p.unit} />
          ) : p.state === "met" ? (
            <span className="font-semibold whitespace-nowrap text-pass">{p.text}</span>
          ) : p.state === "short" ? (
            <span className="font-semibold whitespace-nowrap">{p.text}</span>
          ) : p.state === "none" ? (
            <span className="text-text2">{p.text}</span>
          ) : p.state === "notarget" ? (
            <span className="font-semibold whitespace-nowrap text-warn" title={`Not measurable yet: missing ${(g.missing ?? ["target", "unit"]).join(", ")}`}>
              {p.text}
            </span>
          ) : null}
        </span>
        {change != null && change !== 0 && p.state !== "raw" && (
          <span className="tnum text-sm font-semibold text-text2" data-testid="goal-change">
            <span className="text-text">{`${change > 0 ? "+" : "−"}${amount(Math.abs(change), !!g.current?.compact)}`}</span> {spanMonths(trend!)}m
          </span>
        )}
      </div>
      {subs.length > 0 && <Subgoals g={g} subs={subs} />}
    </li>
  );
}

/** #345: where the goal's progress comes from, and its subgoals, collapsible. */
function Subgoals({ g, subs }: { g: GoalView; subs: GoalView[] }) {
  const pr = g.progress;
  return (
    <div className="min-w-0 border-t border-line pt-2 text-sm" data-testid="goal-subgoals">
      <p className="text-text2" data-testid="goal-rollup" data-source={pr?.source ?? "none"}>
        {pr?.source === "own" && pr.value != null
          ? `${percent(pr.value)} · own measurement`
          : pr?.source === "subgoals" && pr.value != null
            ? `${percent(pr.value)} · from subgoals`
            : "No progress yet"}
      </p>
      <details className="mt-1" open>
        <summary className="cursor-pointer font-medium">{subs.length === 1 ? "1 subgoal" : `${subs.length} subgoals`}</summary>
        <ul className="mt-1 flex flex-col gap-1" aria-label={`Subgoals of ${namedText(g)}`}>
          {subs.map((s) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2" data-testid={`home-goal-${s.tag}`}>
              <span className="flex min-w-0 flex-1">
                <CodeChip kind="goal" entityId={s.id} title={s.title} code={s.code} proposed={s.proposed} />
              </span>
              <span className="tnum flex-none text-text2">{s.progress?.value != null ? percent(s.progress.value) : "–"}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function GoalsPanel({
  goals,
  history,
  error,
  loading,
  canImport,
  testId = "home-goals",
}: {
  goals: GoalView[] | undefined;
  history: Map<string, Point[]>;
  error: string | null;
  loading: boolean;
  /** Approvers and owners build the baseline; a viewer sees no action they cannot take. */
  canImport: boolean;
  /** Home's band by default; Plan shows the same band under its own id. */
  testId?: string;
}) {
  const confirmed = goals?.filter((g) => !g.proposed) ?? [];
  const proposed = goals?.filter((g) => g.proposed) ?? [];
  // Confirmed goals first, then the proposed ones, each in baseline order; the rest are in the Baseline.
  const shown = goals ? shownGoals(goals) : [];
  const more = (goals?.filter((g) => !g.parentId).length ?? 0) - shown.length;
  const cols = Math.min(4, Math.max(1, shown.length));
  return (
    <Panel
      title="Goals"
      testId={testId}
      tools={
        goals &&
        goals.length > 0 && (
          <>
            {confirmed.length > 0 && <Chip kind="pass">{confirmed.length} confirmed</Chip>}
            {proposed.length > 0 && (
              <Chip kind="warn" data-testid="goals-proposed">
                {proposed.length === 1 ? `${proposed[0].code ?? proposed[0].name} proposed` : `${proposed.length} proposed`}
              </Chip>
            )}
            {more > 0 && (
              <LinkButton href="/baseline" data-testid="goals-more">
                {more} more
              </LinkButton>
            )}
            <InfoTip label="goals">
              Current value over target, from the baseline. Ring: how well the evidence supports the goal. Dashed line: the
              target. The trend shows when the baseline has recorded earlier values.
            </InfoTip>
          </>
        )
      }
    >
      {error && (
        <div className="p-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {loading && !goals && <div aria-hidden className="h-[150px] animate-pulse bg-surface2/60" />}
      {goals && shown.length === 0 && (
        <div data-testid="home-goals-empty" className="flex flex-wrap items-center gap-3 px-4 py-4">
          <span className="text-[15px] font-semibold text-text2">No goals yet</span>
          <InfoTip label="building the baseline" align="start">
            Oracle reads your sources and proposes your goals; they show here once confirmed. You can also push a
            baseline YAML with <code>oracle push</code>.
          </InfoTip>
          {canImport && (
            <LinkButton href="/baseline?build=1" className="ml-auto">
              Build the baseline
            </LinkButton>
          )}
        </div>
      )}
      {shown.length > 0 && (
        <ul
          aria-label="Goals"
          className="grid divide-x divide-line max-[600px]:grid-cols-2! max-[600px]:divide-x-0 max-[600px]:[&>li]:border-b max-[600px]:[&>li:nth-child(odd)]:border-r"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {shown.map((g) => (
            <GoalCard key={g.id} g={g} subs={goals!.filter((s) => s.parentId === g.id)} history={history.get(g.id)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
