/** The nine steps of a PRD's journey (I3). */
export const JOURNEY_STEPS = [
  "Idea",
  "Sources",
  "Gaps",
  "Composition",
  "Research",
  "Blockers",
  "Draft run",
  "Review",
  "Publish",
] as const;

export type JourneyStep = (typeof JOURNEY_STEPS)[number];

/**
 * Where a PRD is on its journey. `current` is 1-based.
 * - `pill`: the full track with names (PRD review header); compact dots on a phone.
 * - `bar`: nine bars with first, current and last named (Inspector).
 * - `dots`: nine dots for a table row.
 */
export function JourneyTrack({
  current,
  variant = "pill",
  steps = JOURNEY_STEPS,
}: {
  current: number;
  variant?: "pill" | "bar" | "dots";
  steps?: readonly string[];
}) {
  const state = (i: number) => (i + 1 < current ? "done" : i + 1 === current ? "current" : "todo");
  const label = `Journey ${current} of ${steps.length}: ${steps[current - 1] ?? ""}`;
  const dots = (
    <span role="img" aria-label={label} className="inline-flex items-center gap-[3px]" data-journey-current={current}>
      {steps.map((s, i) => (
        <i
          key={s}
          title={s}
          className={`size-[9px] rounded-full ${
            state(i) === "done"
              ? "bg-accent"
              : state(i) === "current"
                ? "bg-lime shadow-[0_0_0_2px_var(--on-lime)]"
                : "bg-surface2 shadow-[inset_0_0_0_1px_var(--line-strong)]"
          }`}
        />
      ))}
    </span>
  );
  if (variant === "dots") return dots;
  if (variant === "bar") {
    return (
      <div data-journey-current={current}>
        <div role="img" aria-label={label} className="grid grid-cols-9 gap-1">
          {steps.map((s, i) => (
            <i
              key={s}
              title={s}
              className={`h-2.5 rounded-[5px] ${
                state(i) === "done"
                  ? "bg-accent"
                  : state(i) === "current"
                    ? "bg-lime shadow-[inset_0_0_0_2px_var(--on-lime)]"
                    : "bg-surface2 shadow-[inset_0_0_0_1px_var(--line-strong)]"
              }`}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-sm text-text2" aria-hidden>
          <span>{steps[0]}</span>
          <b className="font-semibold text-text">{steps[current - 1]}</b>
          <span>{steps.at(-1)}</span>
        </div>
      </div>
    );
  }
  return (
    <>
      <ol
        aria-label={label}
        data-journey-current={current}
        className="flex w-max max-w-full items-center overflow-hidden rounded-full border border-line bg-surface p-1 max-[900px]:hidden"
      >
        {steps.map((s, i) => {
          const st = state(i);
          return (
            <li
              key={s}
              aria-current={st === "current" ? "step" : undefined}
              className={`flex items-center gap-[7px] rounded-full px-3 py-1.5 text-sm whitespace-nowrap ${
                st === "current" ? "bg-hero font-semibold text-hero-text" : "font-medium text-text2"
              }`}
            >
              <i
                className={`grid size-[22px] place-items-center rounded-full font-mono text-[13px] leading-[22px] not-italic ${
                  st === "done" ? "bg-pass-bg text-pass" : st === "current" ? "bg-lime text-on-lime" : "bg-surface2 text-text2"
                }`}
              >
                {st === "done" ? "✓" : i + 1}
              </i>
              {s}
            </li>
          );
        })}
      </ol>
      <span className="hidden items-center gap-2 text-sm font-medium max-[900px]:inline-flex">
        {dots}
        <b className="tnum font-semibold">
          {current}/{steps.length}
        </b>
        <span className="text-text2">{steps[current - 1]}</span>
      </span>
    </>
  );
}
