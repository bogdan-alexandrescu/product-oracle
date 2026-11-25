// build-palette (#1794): ⌘K (Ctrl+K) or Find opens the palette on every Simple and Detailed page;
// Esc closes it and the focus goes back where it was. A feature opens the one feature panel over
// the page; New PRD opens its sheet on Home.
import { useCallback, useEffect, useRef, useState } from 'react';

import { FeaturePanel, type PanelFeature } from '@/app/simple/roadmap/_panel';
import { usePhone } from '@/components/ds/page-info';
import { NewPrdSheet } from '@/components/simple/NewPrd';
import { useMe } from '@/lib/me';
import { usePathname, useRouter } from '@/lib/nav';

import { useOpenPalette } from './events';
import { PaletteSheet } from './PaletteSheet';

import type { Hit } from './hits';

export function CommandPalette() {
  const { me } = useMe();
  return me ? <PaletteHost /> : null;
}

function PaletteHost() {
  const { can } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<PanelFeature | null>(null);
  const [newPrd, setNewPrd] = useState(false);
  const back = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    back.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const to = back.current;
    back.current = null;
    setTimeout(() => to?.isConnected && to.focus(), 0);
  }, []);
  useOpenPalette(show);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (open) close();
        else show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, show, close]);

  const onPanel = (h: Hit, onRoadmap = false) => {
    if (!h.feature) return;
    if (onRoadmap) router.push('/simple/roadmap');
    setPanel(h.feature);
  };

  return (
    <>
      {panel && (
        <FeaturePanel
          key={`${panel.id ?? ''}|${panel.code}`}
          feature={panel}
          phone={phone}
          canChange={can('create_simple_change')}
          onClose={() => setPanel(null)}
        />
      )}
      {newPrd && (
        <NewPrdSheet onClose={() => setNewPrd(false)} onStarted={() => setNewPrd(false)} />
      )}
      {open && (
        <PaletteSheet
          phone={phone}
          simple={pathname.startsWith('/simple')}
          onClose={close}
          onPanel={onPanel}
          onNewPrd={() => {
            router.push('/simple');
            setNewPrd(true);
          }}
        />
      )}
    </>
  );
}
