/**
 * The selected rail item (aria-current): #225693, white, and a 3 px sky bar 6 px left of the
 * item, inset 10 px top and bottom. Styled from the attribute, so hover never repaints it.
 * Both rails use it (Studio's, Simple's: #723), each in its own mode's rail tokens.
 */
export const RAIL_SELECTED =
  "aria-[current=page]:bg-rail-active aria-[current=page]:font-semibold aria-[current=page]:text-rail-active-text aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2.5 aria-[current=page]:before:-left-[9px] aria-[current=page]:before:w-[3px] aria-[current=page]:before:rounded-[2px] aria-[current=page]:before:bg-rail-bar aria-[current=page]:before:content-['']";
/** On the phone tab bar the bar sits on top instead. */
export const TAB_BAR =
  "before:absolute before:inset-x-2.5 before:-top-1.5 before:h-[3px] before:rounded-[2px] before:bg-rail-bar before:content-['']";
