// build-shortcuts (#1795), KS2 A 'Keys in tooltips': the tip a person gets on hover carries the key
// beside the name: g then r on the rail's Roadmap, Open Enter on a row's name, Close Esc on the
// feature panel. KS3 A on a phone: no keys and no tips; the feature panel gets previous and next
// buttons that step through features in the order j and k do.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ds/Button';
import { usePhone } from '@/components/ds/page-info';

import { Keys } from './KeysSheet';

import type { Key } from './keys';

type Tip = { label: string; k: Key; style: React.CSSProperties };

const ROW_NAME = '[data-testid=prio-title], [data-testid=timeline-row-label]';
const PANEL_CLOSE = '[data-testid=item-panel] button[aria-label=Close]';
// The panel header's own place for them, before its actions, so they cover none of its controls.
const PANEL_STEPS = '[data-testid=item-panel] [data-panel-steps]';

function tipFor(el: Element, go: Key[]): Tip | null {
  const link = el.closest('nav a[href]');
  if (link) {
    const href = link.getAttribute('href');
    const k = go.find((x) => x.href === href);
    if (!k) return null;
    const r = link.getBoundingClientRect();
    return { label: '', k, style: { left: r.right + 8, top: r.top + r.height / 2 - 16 } };
  }
  const name = el.closest(ROW_NAME);
  if (name?.tagName === 'BUTTON' || name?.getAttribute('role') === 'button') {
    const r = name.getBoundingClientRect();
    return {
      label: 'Open',
      k: { keys: ['Enter'], label: '' },
      style: { left: r.right + 8, top: r.top + r.height / 2 - 16 },
    };
  }
  const close = el.closest(PANEL_CLOSE);
  if (close) {
    const r = close.getBoundingClientRect();
    return {
      label: 'Close',
      k: { keys: ['Esc'], label: '' },
      style: { right: window.innerWidth - r.right, top: r.bottom + 6 },
    };
  }
  return null;
}

export function KeyTips({ go }: { go: Key[] }) {
  const phone = usePhone();
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    if (phone) return;
    let timer = 0;
    const over = (e: Event) => {
      window.clearTimeout(timer);
      const t = e.target instanceof Element ? tipFor(e.target, go) : null;
      if (!t) return setTip(null);
      timer = window.setTimeout(() => setTip(t), 400);
    };
    const out = () => {
      window.clearTimeout(timer);
      setTip(null);
    };
    document.addEventListener('mouseover', over);
    document.addEventListener('keydown', out);
    document.addEventListener('scroll', out, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      document.removeEventListener('keydown', out);
      document.removeEventListener('scroll', out, true);
    };
  }, [phone, go]);
  if (phone || !tip) return null;
  return (
    <div
      role="tooltip"
      data-testid="key-tip"
      className="pointer-events-none fixed z-[70] flex items-center gap-2 rounded-lg bg-tip px-2.5 py-1 text-sm whitespace-nowrap text-tip-text shadow-tip"
      style={tip.style}
    >
      {tip.label && <span>{tip.label}</span>}
      <Keys k={tip.k} tip />
    </div>
  );
}

/** The rows' names in j and k order, and the one the panel shows. */
function stepTarget(d: 1 | -1): HTMLElement | null {
  const panel = document.querySelector('[data-testid=item-panel]');
  const shown = panel?.getAttribute('aria-label')?.trim();
  const names = [...document.querySelectorAll<HTMLElement>('[data-testid=prio-row]')]
    .map((r) => r.querySelector<HTMLElement>('button[data-testid=prio-title]'))
    .filter((b): b is HTMLElement => !!b);
  const at = names.findIndex((b) => b.textContent?.trim() === shown);
  if (at < 0) return null;
  return names[at + d] ?? null;
}

/** KS3 A: on a phone the feature panel's previous and next buttons, in its header before its actions. */
export function PhoneSteps() {
  const phone = usePhone();
  // Drawn again when the panel opens, closes or shows another feature.
  const [, setSeen] = useState('');
  useEffect(() => {
    if (!phone) return;
    const look = () => {
      const p = document.querySelector('[data-testid=item-panel]');
      return `${p?.getAttribute('aria-label') ?? ''}|${document.querySelector(PANEL_STEPS) ? 1 : 0}`;
    };
    const first = window.setTimeout(() => setSeen(look()), 0);
    const seen = new MutationObserver(() => setSeen(look()));
    seen.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(first);
      seen.disconnect();
    };
  }, [phone]);
  if (!phone) return null;
  const slot = document.querySelector<HTMLElement>(PANEL_STEPS);
  if (!slot) return null;
  const prev = stepTarget(-1);
  const next = stepTarget(1);
  if (!prev && !next) return null;
  return createPortal(
    <div className="flex flex-none items-center gap-1">
      <Button
        aria-label="Previous feature"
        disabled={!prev}
        onClick={() => prev?.click()}
        className="size-11 px-0"
      >
        ‹
      </Button>
      <Button
        aria-label="Next feature"
        disabled={!next}
        onClick={() => next?.click()}
        className="size-11 px-0"
      >
        ›
      </Button>
    </div>,
    slot,
  );
}
