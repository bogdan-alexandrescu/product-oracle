// build-shortcuts (#1795): the rail's Keys line, which opens the ? sheet: above Ask Oracle in
// Simple's rail, above Settings in Detailed's. Rail chrome, as the rail's Find (PaletteEntry).
import { K } from '@/components/keys/KeysSheet';
import { openKeys } from '@/components/palette/hotkeys';
import { useMe } from '@/lib/me';

import { Icon } from './Icon';

/** The rail's Keys line: above Ask Oracle in Simple's rail, above Settings in Detailed's. */
export function KeysLine({ where }: { where: 'simple-rail' | 'detailed-rail' }) {
  // As the rail's Find: its place is kept while /v1/me loads, and it works once the keys do.
  const { me, loading } = useMe();
  if (!me && !loading) return null;
  const wait = me ? '' : 'invisible';
  if (where === 'simple-rail')
    return (
      <button
        type="button"
        data-testid="keys-entry"
        aria-keyshortcuts="?"
        onClick={openKeys}
        className={`mb-2 flex items-center gap-2 rounded-button px-3 py-1 text-sm text-text2 hover:bg-rail-hover max-[600px]:hidden ${wait}`}
      >
        <Icon name="keyboard" size={16} />
        <span className="flex-1 text-left">Keys</span>
        <K>?</K>
      </button>
    );
  return (
    <button
      type="button"
      data-testid="keys-entry"
      aria-keyshortcuts="?"
      onClick={openKeys}
      className={`mb-1 flex w-[70px] flex-none flex-col items-center gap-0.5 rounded-[10px] py-1 text-sm text-rail-text hover:bg-rail-hover hover:text-rail-active-text ${wait}`}
    >
      <Icon name="keyboard" size={16} />
      <span className="inline-flex items-center gap-1">
        Keys <K>?</K>
      </span>
    </button>
  );
}
