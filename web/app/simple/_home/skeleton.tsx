"use client";

import { Bar, GoalBandSkeleton, HomeCard, SkeletonRows } from "@/app/simple/_home/cards";
import { SimplePage } from "@/components/simple/SimplePage";

/**
 * Simple's Home before the person and their permissions are known (#723 production walk: the
 * first paint was seconds of a blank page): the page frame at once, the greeting, the goal band
 * and the cards as placeholders the size of the real ones, so nothing jumps as they fill.
 */
export function HomeSkeleton() {
  return (
    <SimplePage title="Home">
      <header data-testid="home-greeting" data-skeleton="true" className="-mt-4 flex flex-col gap-1">
        <p className="simple-small">
          <Bar className="w-40" />
        </p>
        <p className="simple-lead">
          <Bar className="w-80 max-w-full" />
        </p>
        {/* Where "Walk me through it" lands for everyone who acts on the plan. */}
        <div aria-hidden>
          <span className="simple-button animate-pulse text-transparent">Walk me through it</span>
        </div>
      </header>
      <section aria-label="Goals" data-testid="home-goals">
        <GoalBandSkeleton />
      </section>
      <HomeCard id="meeting" icon="clock" title="Next review meeting">
        <SkeletonRows n={1} />
      </HomeCard>
      <HomeCard id="plan" icon="roadmap" title="The plan this quarter">
        <SkeletonRows />
      </HomeCard>
    </SimplePage>
  );
}
