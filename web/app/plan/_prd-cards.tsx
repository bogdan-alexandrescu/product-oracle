import Link from "next/link";

import { Chip, JOURNEY_STEPS, JourneyTrack, LinkButton, Panel } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";

import { trackHealth, type PlanPrd } from "./_lib";

type TrackOverview = Schemas["TrackOverview"];

/** At most this many cards; past it, the last card is "+N more". */
const MAX_CARDS = 6;

/**
 * Plan's own words for the journey's end (qa-plan-32): a PRD's roadmap is "Approved", not
 * "Publish" (I3's word for the PRD itself, on its own review header and Inspector).
 */
const PLAN_JOURNEY_STEPS = [...JOURNEY_STEPS.slice(0, -1), "Approved"] as const;

/**
 * One PRD's card. qa-plan-1: a tracked PRD shows its track's health as the track panel's own
 * badge, read from the same track (the panel's, once loaded, so a change there shows here too).
 * qa-plan-53: one subtitle style for every card; the other figures are plain counts.
 */
function PrdCard({ p, track }: { p: PlanPrd; track: TrackOverview | undefined }) {
  const health = p.track ? trackHealth(track?.health ?? p.track.health) : null;
  return (
    <li
      data-testid="plan-prd-card"
      data-slug={p.document.slug}
      data-stage={p.stage}
      className="flex min-w-0 flex-col gap-3 rounded-panel border border-line bg-surface p-4 shadow-panel max-[600px]:p-3"
    >
      <Link href={`/documents/${p.document.slug}`} className="min-h-7 truncate font-display text-[17px] leading-7 font-bold tracking-heading hover:underline">
        {p.document.title}
      </Link>
      <JourneyTrack current={p.journey_step} variant="bar" steps={PLAN_JOURNEY_STEPS} />
      <div className="flex min-w-0 items-baseline justify-between gap-3 text-[15px]">
        <span data-testid="plan-prd-stage" className="min-w-0 text-text2">
          {p.stage_label}
        </span>
        {health ? (
          <Chip kind={health.kind} data-testid="plan-prd-figure" className="flex-none">
            {health.label}
          </Chip>
        ) : (
          p.figure && (
            <span data-testid="plan-prd-figure" className="tnum flex-none whitespace-nowrap text-text2">
              {p.figure}
            </span>
          )
        )}
      </div>
    </li>
  );
}

/** One card per PRD in play (F1 §4): three per row, wrapping; stacked on a phone. */
export function PrdCards({
  prds,
  canWrite,
  tracks,
}: {
  prds: PlanPrd[] | undefined;
  canWrite: boolean;
  /** The track panels' tracks, so a card's health is theirs (qa-plan-1). */
  tracks?: TrackOverview[];
}) {
  if (!prds) return <div aria-hidden className="h-[150px] animate-pulse rounded-panel bg-surface2/60" />;
  if (prds.length === 0) {
    return (
      <Panel testId="plan-prds-empty">
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
          <span className="text-[15px] font-semibold text-text2">No PRDs in play</span>
          {canWrite && (
            <LinkButton href="/documents/new?kind=prd" variant="primary" icon="plus" className="ml-auto">
              New PRD
            </LinkButton>
          )}
        </div>
      </Panel>
    );
  }
  const shown = prds.length > MAX_CARDS ? prds.slice(0, MAX_CARDS - 1) : prds;
  const more = prds.length - shown.length;
  return (
    <ul aria-label="PRDs in play" className="grid grid-cols-3 gap-3 max-[1100px]:grid-cols-2 max-[600px]:grid-cols-1">
      {shown.map((p) => (
        <PrdCard key={p.document.id} p={p} track={p.track ? tracks?.find((t) => t.id === p.track!.id) : undefined} />
      ))}
      {more > 0 && (
        <li className="min-w-0">
          <Link
            href="/documents"
            data-testid="plan-prd-more"
            className="flex h-full min-h-24 items-center justify-center rounded-panel border border-dashed border-line-strong p-4 font-display text-lg font-bold text-accent-ink hover:bg-surface2"
          >
            +{more} more
          </Link>
        </li>
      )}
    </ul>
  );
}
