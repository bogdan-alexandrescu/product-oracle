"use client";

import { Bar, GoalBandSkeleton, HomeCardSkeleton } from "@/app/simple/_home/cards";
import { Icon } from "@/components/ds/Icon";
import { SimplePage } from "@/components/simple/SimplePage";

/**
 * The greeting's sentence keeps, on the first paint, the lines its longest form wraps to, so the
 * goal band under it never jumps down as it fills (home-greeting-fit). The longest form names
 * three kinds, then "and more", then the Inbox ("Good morning, Avery. Decisions, a proposal,
 * broken links and more wait on you. More waits in your Inbox."): 2 lines from a 34rem header
 * up, 3 on a phone, 4 on a narrow phone, 5 beside a narrow window's rail. Kept on the skeleton
 * only: the page's own sentence takes the lines it needs, so a short greeting leaves no empty
 * lines (the band moves up once, never down). The header is the container.
 */
const LEAD = "simple-lead min-h-[5lh] @[19rem]:min-h-[4lh] @sm:min-h-[3lh] @[34rem]:min-h-[2lh]";

/**
 * Simple's Home before the person and their permissions are known (#723 production walk: the
 * first paint was seconds of a blank page): the page frame at once, the greeting, the goal band
 * and the cards as placeholders the size of the real ones, so nothing jumps as they fill. The
 * cards carry no titles: which cards show depends on the permissions still on their way.
 */
export function HomeSkeleton() {
  return (
    <SimplePage title="Home">
      <header data-testid="home-greeting" data-skeleton="true" className="@container -mt-4 flex flex-col gap-1">
        <p className="simple-small">
          <Bar className="w-40" />
        </p>
        <p className={LEAD}>
          <Bar className="w-80 max-w-full" />
        </p>
        {/* Home's own action row, "Walk me through it" and "+ New PRD", wrapping as they do
            (beside a narrow window's rail, to two rows). A reader's Home has none: its band moves up. */}
        <div aria-hidden className="flex flex-wrap gap-2">
          <span className="simple-button animate-pulse text-transparent">Walk me through it</span>
          <span className="simple-button animate-pulse text-transparent">
            <Icon name="plus" size={18} /> New PRD
          </span>
        </div>
      </header>
      <section aria-label="Goals" data-testid="home-goals">
        <GoalBandSkeleton />
      </section>
      {/* Untitled: an owner's first card is the summary, a viewer's the next meeting. */}
      <HomeCardSkeleton n={1} />
      <HomeCardSkeleton />
    </SimplePage>
  );
}
