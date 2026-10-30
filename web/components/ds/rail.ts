/**
 * The selected rail item (aria-current): #225693, white, and a 3 px sky bar 6 px left of the
 * item, inset 10 px top and bottom. Styled from the attribute, so hover never repaints it.
 * Both rails use it (Detailed's, Simple's: #723), each in its own mode's rail tokens.
 */
export const RAIL_SELECTED =
  "aria-[current=page]:bg-rail-active aria-[current=page]:font-semibold aria-[current=page]:text-rail-active-text aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2.5 aria-[current=page]:before:-left-[9px] aria-[current=page]:before:w-[3px] aria-[current=page]:before:rounded-[2px] aria-[current=page]:before:bg-rail-bar aria-[current=page]:before:content-['']";
/**
 * On the phone tab bar the highlight alone marks the selected item (qa-company-37): the sky
 * bar it once had on top stuck out above the highlight as a second indicator. Kept as the one
 * place both tab bars (Detailed's, Simple's) take their selected extras from.
 */
export const TAB_BAR = "";
