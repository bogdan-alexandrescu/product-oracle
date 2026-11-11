"use client";

import { Bar, GoalBandSkeleton, HomeCardSkeleton } from "@/app/simple/_home/cards";
import { SimplePage } from "@/components/simple/SimplePage";

/**
 * The greeting's sentence keeps the lines it wraps to from the first paint, so the goal band under
 * it never jumps as it fills: the header's width says how many ("Decisions, broken links and a run
 * wait on you. More waits in your Inbox." takes 2 lines on a desktop, 3 on a phone, 4 beside a
 * narrow window's rail). The header is the container: Home and its skeleton both use this.
 */
export const LEAD = "simple-lead min-h-[4lh] @xs:min-h-[3lh] @xl:min-h-[2lh]";

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
        {/* Where "Walk me through it" lands (a reader's Home keeps the slot empty). */}
        <div aria-hidden>
          <span className="simple-button animate-pulse text-transparent">Walk me through it</span>
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
