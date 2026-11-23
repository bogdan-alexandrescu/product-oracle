'use client';

import { useState } from 'react';

import { Button } from '@/components/ds';

import { TrackPick } from './_add-track';

import type { Where } from './_lib';

type Ref = { id: string; title: string };

/** The quick add's sheet on a phone: title, roadmap, track and where, then Add or Propose. */
export function AddForm({
  initial,
  options,
  verb,
  roadmaps,
  initialRoadmap,
  target,
  tracks,
  initialTrack,
  onSubmit,
}: {
  initial: string;
  options: Where[];
  verb: (w: Where, roadmap?: string) => 'Add' | 'Propose';
  roadmaps: Ref[];
  initialRoadmap: string;
  target: string | null;
  tracks: Ref[];
  initialTrack: string;
  onSubmit: (title: string, where: Where, roadmap?: string, track?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial);
  const [rm, setRm] = useState(initialRoadmap);
  const [tr, setTr] = useState(initialTrack);
  const askTrack = tracks.length > 1;
  const track = tracks.find((t) => t.id === tr)?.id;
  const ask = roadmaps.length > 0;
  const roadmap = ask ? roadmaps.find((r) => r.id === rm)?.id : undefined;
  const [where, setWhere] = useState(options[0] ? `${options[0].kind}:${options[0].value}` : '');
  const [busy, setBusy] = useState(false);
  const chosen = options.find((o) => `${o.kind}:${o.value}` === where);
  // fix4 qa-simple-roadmap-14: Add pressed with something missing says what, under its field.
  const [tried, setTried] = useState(false);
  const noTitle = tried && !title.trim();
  const noRoadmap = tried && ask && !roadmap;
  const noTrack = tried && askTrack && !track;
  const groups: [string, Where['kind']][] = [
    ['Quarters', 'quarter'],
    ['Now / Next / Later', 'horizon'],
    ['Goals', 'goal'],
  ];
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (!title.trim() || !chosen || (ask && !roadmap) || (askTrack && !track)) return;
        setBusy(true);
        try {
          await onSubmit(title.trim(), chosen, roadmap, track);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Title
        <input
          data-autofocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={noTitle || undefined}
          className={`h-11 rounded-lg border bg-surface px-3 text-base font-normal text-text ${noTitle ? 'border-crit' : 'border-line-strong'}`}
        />
        {noTitle && (
          <span
            role="alert"
            data-testid="quick-add-error"
            className="text-sm font-normal text-crit"
          >
            Type a title
          </span>
        )}
      </label>
      {target && (
        <p className="text-sm text-text2" data-testid="quick-add-target">
          Goes to {target}
        </p>
      )}
      {ask && (
        <label className="flex flex-col gap-1 text-sm font-semibold">
          Roadmap
          <select
            value={rm}
            onChange={(e) => setRm(e.target.value)}
            aria-invalid={noRoadmap || undefined}
            className={`h-11 rounded-lg border bg-surface px-2 text-base font-normal text-text ${noRoadmap ? 'border-crit' : 'border-line-strong'}`}
          >
            <option value="">Which roadmap?</option>
            {roadmaps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          {noRoadmap && (
            <span
              role="alert"
              data-testid="quick-add-error"
              className="text-sm font-normal text-crit"
            >
              Pick the roadmap it goes on
            </span>
          )}
        </label>
      )}
      {askTrack && (
        <TrackPick tracks={tracks} value={tr} onChange={setTr} invalid={noTrack} sheet />
      )}
      <label className="flex flex-col gap-1 text-sm font-semibold">
        Where
        <select
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          className="h-11 rounded-lg border border-line-strong bg-surface px-2 text-base font-normal text-text"
        >
          {groups.map(([label, kind]) => (
            <optgroup key={kind} label={label}>
              {options
                .filter((o) => o.kind === kind)
                .map((o) => (
                  <option key={`${o.kind}:${o.value}`} value={`${o.kind}:${o.value}`}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <Button type="submit" variant="solid" disabled={busy || !chosen}>
        {chosen ? verb(chosen, roadmap) : 'Add'}
      </Button>
    </form>
  );
}
