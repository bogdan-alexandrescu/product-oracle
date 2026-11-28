// build-palette (#1794): ⌘K (Ctrl+K) or Find opens the palette on every Simple and Detailed page;
// Esc closes it and the focus goes back where it was. A feature opens the one feature panel over
// the page; New PRD opens its sheet on Home.
import { useCallback, useRef, useState } from 'react';

import { FeaturePanel, type PanelFeature } from '@/app/simple/roadmap/_panel';
import { usePhone } from '@/components/ds/page-info';
import { NewPrdSheet } from '@/components/simple/NewPrd';
import { useMe } from '@/lib/me';
import { usePathname, useRouter } from '@/lib/nav';

import { useOpenPalette } from './events';
import { usePaletteKeys } from './hotkeys';
import { PaletteSheet } from './PaletteSheet';

import type { Hit } from './hits';

export function CommandPalette() {
  const { me } = useMe();
  return me ? <PaletteHost /> : null;
}

/** The page New PRD's sheet opens on, and the Roadmap a feature is shown on. */
const HOME = '/simple';
const ROADMAP = '/simple/roadmap';

const focusOn = (to: HTMLElement | null) => setTimeout(() => to?.isConnected && to.focus(), 0);

/** What the palette opened over a page: on that page only (`path`), gone with it. */
type Opened = { feature: PanelFeature | null; path: string };

function PaletteHost() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);
  // Where the focus was when the palette opened, and when what it opened did.
  const back = useRef<HTMLElement | null>(null);
  const openedBack = useRef<HTMLElement | null>(null);

  // A panel or sheet stays with its page: another page opens without it.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (opened && opened.path !== pathname) setOpened(null);
  }

  const show = useCallback(() => {
    back.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    focusOn(back.current);
  }, []);
  const openOver = (what: Opened) => {
    const from = back.current;
    // From inside a panel or sheet it replaces, the focus goes back to what opened that one.
    if (!openedBack.current?.isConnected || !opened || !from?.closest('aside, [role="dialog"]'))
      openedBack.current = from;
    setOpened(what);
  };
  const closeOver = useCallback(() => {
    setOpened(null);
    focusOn(openedBack.current);
  }, []);
  useOpenPalette(show);
  // Ctrl or ⌘ K goes through the one key layer (hotkeys.ts), which hands it to the palette first.
  usePaletteKeys(open, open ? close : show);

  const onPanel = (h: Hit, onRoadmap = false) => {
    if (!h.feature) return;
    if (onRoadmap) router.push(ROADMAP);
    openOver({ feature: h.feature, path: onRoadmap ? ROADMAP : pathname });
  };
  const here = opened?.path === pathname ? opened : null;
  const panel = here?.feature;

  return (
    <>
      {panel && (
        <FeaturePanel
          key={`${panel.id ?? ''}|${panel.code}`}
          feature={panel}
          phone={phone}
          canChange={can('create_simple_change')}
          onClose={closeOver}
        />
      )}
      {here && !panel && <NewPrdSheet onClose={closeOver} onStarted={() => setOpened(null)} />}
      {open && (
        <PaletteSheet
          phone={phone}
          simple={pathname.startsWith('/simple')}
          onClose={close}
          onPanel={onPanel}
          onNewPrd={() => {
            router.push(HOME);
            openOver({ feature: null, path: HOME });
          }}
        />
      )}
    </>
  );
}
