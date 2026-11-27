// build-shortcuts (#1795), KS1 B: the ? sheet. It slides in on the right with a search box, lists
// this page first, then Go to and Everywhere, and folds other pages' keys under their names. A
// viewer sees move and add struck out as view only; a commenter's read as suggestions.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ds/Button';

import { isEdit, matches, suggestionLabel, type Group, type Key } from './keys';

export type Changes = 'none' | 'suggests' | 'edits';

export function K({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-line-strong bg-surface2 px-1.5 font-mono text-sm leading-6 text-text">
      {children}
    </kbd>
  );
}

/** A key's keys: "g then r", "Shift + J", "j or ↓". */
export function Keys({ k, tip }: { k: Key; tip?: boolean }) {
  const join = tip ? 'text-xs text-tip-text' : 'text-xs text-text-faint';
  return (
    <span className="inline-flex items-center gap-1">
      {k.keys.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className={join}>{k.then ? 'then' : '+'}</span>}
          <K>{x}</K>
        </span>
      ))}
      {k.alt && <span className={join}>or</span>}
      {k.alt?.map((x) => (
        <K key={x}>{x}</K>
      ))}
    </span>
  );
}

function Row({ k, changes }: { k: Key; changes: Changes }) {
  if (changes === 'none' && isEdit(k))
    return (
      <li
        data-testid="keys-row"
        className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-text-faint"
      >
        <span className="line-through">{k.label}</span>
        <span className="text-xs">View only</span>
      </li>
    );
  return (
    <li
      data-testid="keys-row"
      className="flex items-center justify-between gap-3 rounded-lg px-2 py-1"
    >
      <span className="text-text">
        {changes === 'suggests' ? suggestionLabel(k.label) : k.label}
      </span>
      <Keys k={k} />
    </li>
  );
}

export function KeysSheet({
  groups,
  changes,
  onClose,
}: {
  groups: Group[];
  changes: Changes;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    return () => {
      const to = back.current;
      setTimeout(() => to?.isConnected && to.focus(), 0);
    };
  }, []);
  return (
    <div
      data-keys-sheet
      data-testid="keys-sheet"
      role="dialog"
      aria-label="Keys"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      className="fixed top-3 right-3 bottom-3 z-[80] flex w-[400px] flex-col rounded-xl border border-line bg-surface shadow-tip max-[600px]:left-3 max-[600px]:w-auto"
    >
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-lg font-semibold text-text">Keys</h2>
        <Button variant="ghost" aria-label="Close" icon="x" onClick={onClose} />
      </div>
      <div className="px-4 pt-3">
        <input
          autoFocus
          type="search"
          aria-label="Find a key"
          placeholder="Find a key"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-base text-text"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4 text-sm">
        {groups.map((gr) => {
          const ks = gr.keys.filter((k) => matches(k, q));
          if (!ks.length) return null;
          const open = gr.open || !!q.trim() || unfolded.includes(gr.name);
          return (
            <section key={gr.name} className="mt-2" data-testid="keys-group">
              {gr.open ? (
                <h3 className="px-2 py-1 font-semibold text-text2">{gr.name}</h3>
              ) : (
                <h3>
                  <Button
                    variant="ghost"
                    aria-expanded={open}
                    onClick={() =>
                      setUnfolded((u) => (open ? u.filter((x) => x !== gr.name) : [...u, gr.name]))
                    }
                    className="w-full px-2"
                  >
                    <span className="flex-1 text-left font-semibold">{gr.name}</span>
                    {!open && <span className="text-text-faint">{ks.length} ›</span>}
                  </Button>
                </h3>
              )}
              {open && (
                <ul>
                  {ks.map((k) => (
                    <Row key={gr.name + k.label} k={k} changes={changes} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
