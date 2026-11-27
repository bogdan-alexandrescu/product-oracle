// build-palette (#1794), CP1 a: one line per result: an icon for its kind, the code and name, then
// its kind and where it lives on the right; the picked row shows its keys. An option of the
// box's listbox: the box keeps the focus, so the keys work from there (aria-activedescendant).
import { Icon, type IconName } from '@/components/ds/Icon';

import type { Hit } from './hits';

export const KBD = 'rounded border border-line bg-bg px-1.5 font-mono text-xs text-text-faint';

function iconOf(h: Hit): IconName {
  if (h.kind === 'Feature') return 'roadmap';
  if (h.kind === 'PRD') return 'doc';
  if (h.kind === 'Goal' || h.kind === 'Key result') return 'target';
  if (h.kind === 'Milestone') return 'clock';
  if (h.kind === 'Action') return h.key.includes('ask') ? 'ask' : 'more';
  return 'link';
}

const placeOf = (h: Hit) =>
  h.kind === 'Page' || h.kind === 'Action' ? h.where : `${h.kind} · ${h.where}`;

export function PaletteRow({
  hit,
  index,
  on,
  keys,
  tab,
  onPoint,
  onPick,
}: {
  hit: Hit;
  index: number;
  on: boolean;
  /** Show the keys of the picked row (not on a phone). */
  keys: boolean;
  /** Tab opens this feature's own actions. */
  tab: boolean;
  onPoint: () => void;
  onPick: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={on}
      id={`palette-opt-${index}`}
      data-testid="palette-row"
      onMouseEnter={onPoint}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left ${on ? 'bg-accent-soft' : 'hover:bg-bg'}`}
    >
      <span className="flex size-7 flex-none items-center justify-center rounded-md border border-line bg-surface text-text-faint">
        <Icon size={16} name={iconOf(hit)} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {hit.code && (
          <span className="flex-none font-mono text-sm text-text-faint">{hit.code}</span>
        )}
        <span
          className={`min-w-0 truncate text-base text-text ${on ? 'font-semibold' : 'font-medium'}`}
        >
          {hit.name}
        </span>
      </span>
      <span className="max-w-[45%] flex-none truncate text-sm text-text-faint max-[600px]:hidden">
        {placeOf(hit)}
      </span>
      {on && keys && tab && <span className={KBD}>Tab</span>}
      {on && keys && <span className={KBD}>↵</span>}
    </li>
  );
}

/** "5 more features ↓": the rest of a kind, in the arrow order as the rows are. */
export function PaletteMoreRow({
  hit,
  index,
  on,
  onPoint,
  onPick,
}: {
  hit: Hit;
  index: number;
  on: boolean;
  onPoint: () => void;
  onPick: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={on}
      id={`palette-opt-${index}`}
      data-testid="palette-more"
      onMouseEnter={onPoint}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={`mx-1 inline-flex h-8 cursor-pointer items-center rounded-lg px-2.5 text-sm font-medium text-accent-ink ${on ? 'bg-accent-soft' : 'hover:bg-accent-soft'}`}
    >
      {hit.name}
    </li>
  );
}
