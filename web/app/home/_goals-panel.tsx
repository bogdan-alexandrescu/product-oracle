"use client";

import { Chip, GoalTag, InfoTip, LinkButton, Notice, Panel, Ring, Sparkline, ToGo } from "@/components/ds";

import { formatValue, spanMonths, type GoalView, type Point } from "./_goals";

/** One goal: id and title, current over target, confidence ring, trend when there is history, distance to go. */
function GoalCard({ g, history }: { g: GoalView; history: Point[] | undefined }) {
  const trend = history && history.length >= 2 ? history : null;
  const change = trend ? Math.round((trend.at(-1)!.value - trend[0].value) * 10) / 10 : null;
  return (
    <li
      data-testid={`home-goal-${g.tag}`}
      data-proposed={g.proposed || undefined}
      className="flex min-w-0 flex-col gap-2 border-line px-4 pt-3.5 pb-3 max-[600px]:px-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <GoalTag id={g.tag} proposed={g.proposed} title={g.proposed ? `${g.tag} · proposed` : g.tag} />
        <span className="line-clamp-2 min-w-0 flex-1 font-semibold" title={g.metric ?? g.title}>
          {g.title}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0" data-testid="goal-figure">
          {g.current ? (
            <b className="tnum font-display text-[34px] leading-9 font-bold tracking-[-0.03em]">{formatValue(g.current, g.unit)}</b>
          ) : (
            <b className="tnum font-display text-[34px] leading-9 font-bold text-text2" aria-label="No current value">
              –
            </b>
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
            target={g.target?.value}
            width={240}
            height={40}
            label={`${g.tag} trend: ${trend.map((p) => p.value).join(", ")}; target ${g.targetText ?? "–"}`}
          />
        </div>
      )}
      <div className="mt-auto flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-[15px]">
        <span data-testid="goal-to-go">
          {g.current && g.target ? (
            g.met ? (
              <ToGo current={g.target.value} target={g.target.value} />
            ) : (
              <ToGo current={g.current.value} target={g.target.value} unit={g.unit} />
            )
          ) : (
            <span className="text-text2">No current value</span>
          )}
        </span>
        {change != null && change !== 0 && (
          <span className="tnum text-sm font-semibold text-text2" data-testid="goal-change">
            <span className="text-text">{change > 0 ? `+${change}` : `−${Math.abs(change)}`}</span> {spanMonths(trend!)}m
          </span>
        )}
      </div>
    </li>
  );
}

export function GoalsPanel({
  goals,
  history,
  error,
  loading,
}: {
  goals: GoalView[] | undefined;
  history: Map<string, Point[]>;
  error: string | null;
  loading: boolean;
}) {
  const confirmed = goals?.filter((g) => !g.proposed) ?? [];
  const proposed = goals?.filter((g) => g.proposed) ?? [];
  // Confirmed goals first, then the proposed ones, each in baseline order.
  const shown = [...confirmed, ...proposed];
  const cols = Math.min(4, Math.max(1, shown.length));
  return (
    <Panel
      title="Goals"
      testId="home-goals"
      tools={
        goals &&
        goals.length > 0 && (
          <>
            {confirmed.length > 0 && <Chip kind="pass">{confirmed.length} confirmed</Chip>}
            {proposed.length > 0 && (
              <Chip kind="warn" data-testid="goals-proposed">
                {proposed.length === 1 ? `${proposed[0].tag} proposed` : `${proposed.length} proposed`}
              </Chip>
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
          <InfoTip label="importing a baseline" align="start">
            Push a baseline YAML with <code>oracle push</code>, or start a Baseline to PRD run; its goals show here once
            confirmed.
          </InfoTip>
          <LinkButton href="/baseline" className="ml-auto">
            Import your baseline
          </LinkButton>
        </div>
      )}
      {shown.length > 0 && (
        <ul
          aria-label="Goals"
          className="grid divide-x divide-line max-[600px]:grid-cols-2! max-[600px]:divide-x-0 max-[600px]:[&>li]:border-b max-[600px]:[&>li:nth-child(odd)]:border-r"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {shown.map((g) => (
            <GoalCard key={g.id} g={g} history={history.get(g.id)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
