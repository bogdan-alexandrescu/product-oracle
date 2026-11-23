'use client';

import { useRef, useState, type RefObject } from 'react';

type Ref = { id: string; title: string };

/**
 * roadmap-add: the add field's and the add sheet's Track pick ("Which track?" until one is
 * picked); `invalid` marks it red, and the sheet says why beside it.
 */
export function TrackPick({
  tracks,
  value,
  onChange,
  invalid,
  sheet = false,
  pickRef,
}: {
  tracks: Ref[];
  value: string;
  onChange: (id: string) => void;
  invalid: boolean;
  sheet?: boolean;
  pickRef?: RefObject<HTMLSelectElement | null>;
}) {
  const pick = (
    <select
      ref={pickRef}
      aria-label={sheet ? undefined : "New item's track"}
      data-testid="quick-add-track"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      aria-describedby={!sheet && invalid ? 'quick-add-track-error' : undefined}
      className={`rounded-lg border bg-surface px-2 text-base text-text ${sheet ? 'h-11 font-normal' : 'h-9'} ${invalid ? 'border-crit' : 'border-line-strong'}`}
    >
      <option value="">Which track?</option>
      {tracks.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );
  if (!sheet) return pick;
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold">
      Track
      {pick}
      {invalid && (
        <span role="alert" data-testid="quick-add-error" className="text-sm font-normal text-crit">
          Pick the track it goes on
        </span>
      )}
    </label>
  );
}

/** roadmap-add: the add field's track: the Track filter's to start with (again when it changes);
 * `picked` is it, or the only track; `ask` with more than one. */
export function useTrackPick(tracks: Ref[], track: string | null) {
  const [value, setValue] = useState(track ?? '');
  const [from, setFrom] = useState(track);
  if (from !== track) {
    setFrom(track);
    setValue(track ?? '');
  }
  const [invalid, setInvalid] = useState(false);
  const pickRef = useRef<HTMLSelectElement>(null);
  const only = tracks.length === 1 ? tracks[0].id : undefined;
  return {
    ask: tracks.length > 1,
    only,
    picked: tracks.find((t) => t.id === value)?.id ?? only,
    setValue,
    invalid,
    setInvalid,
    props: {
      tracks,
      value,
      invalid,
      pickRef,
      onChange: (v: string) => {
        setValue(v);
        setInvalid(false);
      },
    },
  };
}
