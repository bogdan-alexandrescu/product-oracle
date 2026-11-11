"use client";

import { Bar, GoalBandSkeleton, HomeCardSkeleton } from "@/app/simple/_home/cards";
import { Icon } from "@/components/ds/Icon";
import { SimplePage } from "@/components/simple/SimplePage";

/**
 * The greeting's sentence keeps the lines its longest form wraps to, so the goal band under it
 * never jumps as it fills (home-greeting-fit). The longest form names three kinds in the
 * singular, then "and more", then the Inbox, after the longest greeting word and a 12-letter
 * first name ("Good afternoon, Christabelle. A decision, a proposal, a broken link and more wait
 * on you. More waits in your Inbox."): measured every 5 px from 360 to 1600 (Inter Tight, Linux),
 * it takes 5 lines in a header up to 322 px, 4 up to 442, 3 up to 607 and 2 from 612, so each
 * step comes a few percent past where it is needed (a font drawn wider on another system still
 * fits). Kept on the skeleton and on the page's own sentence while what waits is unknown
 * ("Checking what waits on you..."); once known, the sentence takes the lines it needs, so a
 * short greeting leaves no empty lines (the band moves up once, never down). The header is the
 * container.
 */
export const LEAD = "simple-lead min-h-[5lh] @[21rem]:min-h-[4lh] @[28.5rem]:min-h-[3lh] @[39.5rem]:min-h-[2lh]";

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
