// build-palette (#1794), CP3 a 'Find in the rail': a Find row at the top of the Simple rail with
// its ⌘K hint, a Find tile in Detailed's narrow rail, and a search button in the phone's top bar
// beside Ask. Each opens the same palette as ⌘K. Rail chrome, as the shell's own rail rows.
import { openPalette } from '@/components/palette/events';
import { useMe } from '@/lib/me';

import { Icon } from './Icon';

export function PaletteEntry({
  where,
}: {
  where: 'simple-rail' | 'detailed-rail' | 'phone-header';
}) {
  const { me, loading } = useMe();
  // While /v1/me loads its place is kept, so the rail's rows never move down once it answers.
  if (!me && !loading) return null;
  const wait = me ? '' : 'invisible';
  if (where === 'simple-rail')
    return (
      <button
        type="button"
        onClick={openPalette}
        data-testid="palette-entry"
        aria-keyshortcuts="Meta+K Control+K"
        className={`mb-1 flex h-12 w-full items-center gap-3 rounded-xl border border-rail-sep px-3 text-left text-[length:var(--simple-rail-label)] font-medium text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${wait}`}
      >
        <Icon name="search" stroke={1.7} />
        <span className="flex-1">Find</span>
        <span className="rounded border border-rail-sep px-1.5 font-mono text-xs">⌘K</span>
      </button>
    );
  if (where === 'detailed-rail')
    return (
      <button
        type="button"
        onClick={openPalette}
        data-testid="palette-entry"
        aria-keyshortcuts="Meta+K Control+K"
        className={`flex w-[72px] flex-none flex-col items-center gap-0.5 rounded-xl py-1.5 text-sm text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${wait}`}
      >
        <Icon name="search" />
        Find
      </button>
    );
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Find"
      data-testid="palette-entry-phone"
      className="hidden size-10 flex-none items-center justify-center rounded-full text-rail-active-text max-[600px]:flex"
    >
      <Icon name="search" />
    </button>
  );
}
