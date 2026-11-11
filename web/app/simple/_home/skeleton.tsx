"use client";

import { Bar, GoalBandSkeleton, HomeCardSkeleton } from "@/app/simple/_home/cards";
import { Icon } from "@/components/ds/Icon";
import { SimplePage } from "@/components/simple/SimplePage";

/**
 * The greeting's sentence keeps the lines its longest form wraps to, so the goal band under it
 * never jumps as it fills (home-greeting-fit). The widest forms name three kinds in the singular,
 * then "and more", then the Inbox ("Good afternoon, Mohammadreza. A decision, a proposal, a broken
 * link and more wait on you. More waits in your Inbox."), or put the fixes to propose among them,
 * after the longest greeting word and the widest 12-letter first name measured (Mohammadreza,
 * wider than Christabelle): measured every px around each step (Inter Tight, Linux), they take 6
 * lines in a header up to 290 px, 5 up to 345, 4 up to 455, 3 up to 607 and 2 from 612. Each step
 * comes 5 px or more past where it is needed; the 3-line one (the owner's pick, Nov 11) at 468 px,
 * 12 px (2.6%) past the 456 it needs, so a font a little wider still fits: in a header of 456 to
 * 467 px (beside the rail at 800 px, 457) the skeleton keeps a spare fourth line, which the band
 * leaves once what waits is known (up a line, 28 px, once; never down). A phone at 390 px (358)
 * keeps no spare line. Kept on the skeleton and on the page's own sentence while what waits is unknown
 * ("Checking what waits on you..."); once known, the sentence takes the lines it needs, so a
 * short greeting leaves no empty lines (the band moves up once, never down). The header is the
 * container.
 */
export const LEAD = "simple-lead min-h-[6lh] @[18.5rem]:min-h-[5lh] @[22rem]:min-h-[4lh] @[29.25rem]:min-h-[3lh] @[39.5rem]:min-h-[2lh]";

const RESERVE =
  "min-[600px]:[body:not(:has(nav[aria-label=Simple]))_&]:pl-[var(--simple-rail-width)] max-[600px]:[body:not(:has([data-testid=phone-header]))_&]:pt-[var(--phone-top-bar)]";

/**
 * Simple's Home before the person and their permissions are known (#723 production walk: the
 * first paint was seconds of a blank page): the page frame at once, the greeting, the goal band
 * and the cards as placeholders the size of the real ones, so nothing jumps as they fill. The
 * cards carry no titles: which cards show depends on the permissions still on their way.
 */
export function HomeSkeleton() {
  return (
    // The first frames come before the rail and the phone's top bar (drawn once the page is
    // live): until they are there, their place is kept here, so the band is first drawn where
    // it stays (home-greeting-fit-3).
    <div className={RESERVE}>
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
    </div>
  );
}
