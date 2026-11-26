// build-palette (#1794): what the palette shows in place of rows: nothing matches (its choices
// walk with the arrow keys, as rows do), still reading, and a read that failed.
import { Button } from '@/components/ds/Button';
import { Notice } from '@/components/ds/Layout';

import type { Hit } from './hits';

/** CP2 b: Enter adds the words as an item (or proposes it), else asks Oracle. */
export function NoMatch({
  words,
  choices,
  sel,
  onPoint,
  onPick,
}: {
  words: string;
  choices: Hit[];
  sel: number;
  onPoint: (i: number) => void;
  onPick: (h: Hit) => void;
}) {
  return (
    <div className="px-3 py-6 text-center" data-testid="palette-none">
      <p className="text-base font-semibold text-text">Nothing matches “{words}”</p>
      <div
        role="listbox"
        aria-label="Nothing matches"
        className="mt-3 flex flex-wrap justify-center gap-2"
      >
        {choices.map((h, i) => (
          <Button
            key={h.key}
            id={`palette-opt-${i}`}
            role="option"
            aria-selected={i === sel}
            tabIndex={-1}
            variant={i === sel ? 'solid' : 'secondary'}
            onMouseEnter={() => onPoint(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(h)}
          >
            {h.name}
            {i === sel && <span className="ml-1 opacity-70">↵</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** The reads have not answered: nothing is said to be missing yet. */
export function Reading() {
  return (
    <div aria-busy="true" data-testid="palette-loading" className="flex flex-col gap-1 px-1 pt-3">
      {[0, 1, 2].map((n) => (
        <span key={n} aria-hidden className="flex items-center gap-3 px-2 py-2">
          <span className="size-7 flex-none animate-pulse rounded-md bg-surface2" />
          <span className="h-3 w-1/2 animate-pulse rounded bg-surface2" />
        </span>
      ))}
    </div>
  );
}

export function ReadFailed({ error, onAgain }: { error: string; onAgain: () => void }) {
  return (
    <div className="px-1 pt-3">
      <Notice
        tone="error"
        testId="palette-failed"
        action={
          <Button onClick={onAgain} data-testid="palette-again">
            Try again
          </Button>
        }
      >
        {error}
      </Notice>
    </div>
  );
}
