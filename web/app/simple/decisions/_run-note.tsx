'use client';

import { useState } from 'react';

import { Button } from '@/components/ds/Button';
import type { Schemas } from '@/lib/api/client';

/** A note longer than this shows its start, with Show more. */
const LONG = 90;

type NoteCode = Schemas['SimpleNoteCode'];

/** #1866: the shown text with each code the API named followed by its name ("F-104 Quiet hours"), unless the name follows already. */
function withNames(text: string, codes: NoteCode[]) {
  const named = new Map(codes.map((c) => [c.code, c.name]));
  if (!named.size) return text;
  const esc = [...named.keys()].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(?<![\\w-])(${esc.join('|')})(?![\\w-])`));
  return parts.map((part, i) => {
    const name = i % 2 ? named.get(part) : undefined;
    if (!name || (parts[i + 1] ?? '').trimStart().startsWith(name)) return part;
    return (
      <span key={i} data-testid="run-note-code">
        {part} <span data-testid="run-note-code-name">{name}</span>
      </span>
    );
  });
}

/** #1780: the note a person left at a run stop; a long one shows its start, with Show more. #1866: each code with its name. */
export function RunNote({ note, codes = [] }: { note: string; codes?: NoteCode[] }) {
  const [open, setOpen] = useState(false);
  const long = note.length > LONG;
  return (
    <span data-testid="run-stop-note">
      <span data-user-content="">
        {withNames(long && !open ? `${note.slice(0, LONG).trimEnd()}…` : note, codes)}
      </span>
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
