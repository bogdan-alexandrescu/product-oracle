'use client';

import { useState } from 'react';

import { Button } from '@/components/ds/Button';

/** A note longer than this shows its start, with Show more. */
const LONG = 90;

/** #1780: the note a person left at a run stop; a long one shows its start, with Show more. */
export function RunNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  const long = note.length > LONG;
  return (
    <span data-testid="run-stop-note">
      <span data-user-content="">{long && !open ? `${note.slice(0, LONG).trimEnd()}…` : note}</span>
      {long && (
        <Button
          variant="ghost"
          className="!h-auto !px-1 !py-0 align-baseline"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      )}
    </span>
  );
}

/** #1779: Waiting for you while its list is read: two pulsing rows, named for a screen reader. */
export function WaitingSkeleton() {
  return (
    <span
      role="status"
      aria-label="Loading what waits on you"
      data-testid="waiting-skeleton"
      className="flex flex-col gap-2 py-1"
    >
      <span className="block h-5 w-3/4 animate-pulse rounded bg-surface2" />
      <span className="block h-5 w-1/2 animate-pulse rounded bg-surface2" />
    </span>
  );
}
