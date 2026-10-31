# QA pass 4 · Simple roadmap · design changes (8)
Found on the mock app (invented data) at desktop 1512 and phone 390, train AD's build. Ids qa4-<area>-N.

## qa4-simple-roadmap-3 · major · On-screen Timeline squeezes three years: tiny, overlapping, unlabelled bars
- Page: /simple/roadmap
- What: The on-screen Timeline at 1440 px compresses three years into the chart, so bars are tiny, item labels overlap neighbouring bars and dependency lines, and several bars carry no label at all.
- Steps: Simple > Roadmap > Timeline, Group by Goal, desktop.
- Expected: Readable bars with their names (a default window around today with horizontal scroll, or a zoom), labels never sitting on other bars.

## qa4-simple-roadmap-4 · major · Conflict banners drawn over bars and labels
- Page: /simple/roadmap
- What: Dependency-conflict banners (⚠ … Move the dependents / Move the dependency / Accept as risk) are drawn across the chart on top of bars and lane rows, hiding item labels (e.g. "history export", "plan tiers" cut off) in Timeline and Waterfall.
- Steps: Simple > Roadmap > Timeline or Waterfall with the default data (3 broken links); look under Grow retention.
- Expected: Conflicts listed in their own panel or a reserved row, never covering bars; the banner text not truncated with an ellipsis.

## qa4-simple-roadmap-5 · major · 'Move the dependency' moves dates to 2027 but items stay in Now
- Page: /simple/roadmap
- What: After "Move the dependency" on a conflict, items keep their Now horizon while their dates move into 2027, so the Now column (Oct 1 – Dec 31) lists Alert rules engine, Weekly alert digest and Mobile alert push dated Mar–Jun 2027 with a "Dates outside Now" tag.
- Steps: Timeline > on a broken link click Move the dependency; open Now / Next / Later.
- Expected: Fixing a date conflict also moves the item to the matching horizon, or asks which horizon it belongs in.
- Where: web/app/simple/roadmap/_board.tsx:376

## qa4-simple-roadmap-7 · major · One red used for draft, broken link, cut item and Today
- Page: /simple/roadmap
- What: The same red is used for a Draft's dashed outline, a broken link, the cut item and the Today line, so a draft reads as an error and Today reads as a conflict.
- Steps: Simple > Roadmap > Timeline; compare Draft · Team invite nudges, broken-link bars and the Today line/pill.
- Expected: Distinct colours (and the legend agreeing): draft neutral/dashed, broken link red, today a separate accent.

## qa4-simple-roadmap-11 · major · Opening an item card jumps the page and hides the item
- Page: /simple/roadmap
- What: Opening an item card scrolls the page so the left rail ends partway down and a grey empty band fills the rest of the window below it; the card itself floats over the chart, hiding the item it describes.
- Steps: Simple > Roadmap > Timeline; click a bar (e.g. Setup failure alerts).
- Expected: The card opens as a side drawer or popover beside the bar, the page not jumping, the rail filling the window.

## qa4-simple-roadmap-15 · major · Phone Timeline is an unreadable thumbnail
- Page: /simple/roadmap
- What: Phone Timeline is a thumbnail: bars have no names, the axis shows only years/half-years, and the whole chart fits ~350 px so nothing can be read or tapped reliably.
- Steps: Phone 390x844; Simple > Roadmap > Timeline.
- Expected: A phone layout with readable named rows (the list under the chart is fine) or a scrollable chart with names.

## qa4-simple-roadmap-44 · minor · Filters persist across reload and visits with no indication on load
- Page: /simple/roadmap
- What: Filters persist across reload and visits with no indication on load; coming back to the page shows "Nothing matches these filters" or a partial roadmap while the header still says "All roadmaps".
- Steps: Set PRD = Plan changes, Goal = Faster activation; reload.
- Expected: A visible "Filtered" summary in the header, or filters reset on a new visit.

## qa4-simple-roadmap-45 · minor · "Roadmap" appears three times at the top with different jobs
- Page: /simple/roadmap
- What: "Roadmap" appears three times at the top with different jobs: the heading, the Which roadmap? picker for adding, and the Roadmap filter ("All roadmaps"), plus an "All roadmaps" subtitle.
- Steps: Simple > Roadmap; read the top band.
- Expected: One roadmap choice that both filters and is the default for Add.
