'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button, Icon, Sheet } from '@/components/ds';
import { lastUsed, rememberUsed, useNewItemAsk } from '@/components/palette/events';

import { mark, trackAt, whereAt } from './_add-drop';
import { AddForm } from './_add-form';
import { TrackPick, useTrackPick } from './_add-track';

import type { Where } from './_lib';

type Ref = { id: string; title: string };

/**
 * S7's quick add. A desktop types a title, then either drags its chip onto a quarter column
 * of the timeline, a Now / Next / Later column of the board or a goal's header (any element
 * with data-add-where="kind:value"), or presses Enter to add it straight away, as a draft,
 * to the first of those places; it can be dragged to the right place after. A phone taps
 * Add: a sheet with the title and where. The page sends the add_item change (editors apply,
 * others propose). The Roadmap filter decides which roadmap: one chosen (`target`) is named
 * in the field; with all roadmaps and more than one (`roadmaps`), the field and the sheet
 * ask which (a select), and nothing is sent until one is chosen.
 * roadmap-add: the track it goes on is the one picked in the field (the Track filter's to
 * start with), else the track row it is dropped on (data-add-track="<track id>" around the
 * drop); with more than one track and none of those, it asks for one instead of guessing.
 */
export function QuickAdd({
  phone,
  options,
  verb,
  onAdd,
  target = null,
  roadmaps = [],
  tracks = [],
  track = null,
}: {
  phone: boolean;
  options: Where[];
  /** "Add" when the caller's change applies there, else "Propose". */
  verb: (w: Where, roadmap?: string) => 'Add' | 'Propose';
  onAdd: (title: string, where: Where, roadmap?: string, track?: string) => Promise<boolean>;
  /** The one roadmap the item goes to (the Roadmap filter's), named in the field. */
  target?: string | null;
  /** All roadmaps and more than one: the roadmaps to choose from. */
  roadmaps?: Ref[];
  /** roadmap-add: the tracks it may go on (more than one: the field asks which). */
  tracks?: Ref[];
  /** The Track filter's track, picked to start with. */
  track?: string | null;
}) {
  const [title, setTitle] = useState('');
  const [rm, setRm] = useState('');
  const trk = useTrackPick(tracks, track);
  const [sheet, setSheet] = useState(false);
  const ask = roadmaps.length > 0;
  const chosen = ask ? roadmaps.find((r) => r.id === rm)?.id : undefined;
  const ready = !!title.trim() && (!ask || !!chosen);
  // fix4 qa-simple-roadmap-14: an add tried with something missing says what, beside it.
  const [tried, setTried] = useState(false);
  const noTitle = tried && !title.trim();
  const noRoadmap = tried && ask && !chosen;
  const picker = useRef<HTMLSelectElement>(null);
  const drag = useRef<{
    pointer: number;
    ghost: HTMLElement;
    x0: number;
    y0: number;
    over: HTMLElement | null;
  } | null>(null);

  const parse = (attr: string): Where | null => {
    const at = attr.indexOf(':');
    const kind = attr.slice(0, at) as Where['kind'];
    const value = attr.slice(at + 1);
    return (
      options.find((o) => o.kind === kind && o.value === value) ?? { kind, value, label: value }
    );
  };

  const send = async (where: Where, dropped?: string) => {
    const t = title.trim();
    if (!t || (ask && !chosen)) return;
    const onTrack = where.kind === 'track' ? where.value : (dropped ?? trk.picked);
    if (trk.ask && !onTrack) {
      trk.setInvalid(true);
      trk.props.pickRef.current?.focus();
      return;
    }
    if (await onAdd(t, where, chosen, onTrack)) {
      rememberUsed({ roadmap: chosen, track: onTrack });
      setTitle('');
      setTried(false);
      trk.setInvalid(false);
    }
  };

  /** Enter, on a desktop: add it straight away (as a draft) to the first available place,
   * same as dropping the chip there — no sheet repeating the title and roadmap it already has. */
  const sendDefault = () => {
    setTried(!ready);
    // qa4-simple-roadmap-17: a title with no roadmap yet: focus goes to the picker the message names.
    if (title.trim() && ask && !chosen) picker.current?.focus();
    if (ready && options[0]) void send(options[0]);
  };

  // build-palette (#1794): the palette's New item hands its words here; with "new …" typed, an
  // editor's item is added at once on the roadmap and track used last (else the first).
  const titleBox = useRef<HTMLInputElement>(null);
  useNewItemAsk(options.length > 0, (a) => {
    const last = lastUsed();
    const lastRm = roadmaps.find((r) => r.id === last.roadmap)?.id;
    const lastTrack = tracks.find((t) => t.id === last.track)?.id;
    const r = ask ? (lastRm ?? (a.add ? roadmaps[0]?.id : undefined)) : undefined;
    const k = lastTrack ?? trk.picked ?? (a.add ? tracks[0]?.id : undefined);
    const where = options[0];
    const onTrack = where.kind === 'track' ? where.value : k;
    if (a.add && (!ask || r) && (!trk.ask || onTrack)) {
      void onAdd(a.title, where, r, onTrack).then((ok) => {
        if (ok) rememberUsed({ roadmap: r, track: onTrack });
      });
      return;
    }
    setTitle(a.title);
    if (r) setRm(r);
    if (k) trk.setValue(k);
    if (phone) setSheet(true);
    else setTimeout(() => titleBox.current?.focus(), 0);
  });

  const onDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (!ready) {
      setTried(true);
      return;
    }
    e.preventDefault();
    const chip = e.currentTarget;
    try {
      chip.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is gone already.
    }
    const r = chip.getBoundingClientRect();
    const ghost = chip.cloneNode(true) as HTMLElement;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${r.left}px`,
      top: `${r.top}px`,
      pointerEvents: 'none',
      zIndex: '70',
      opacity: '0.9',
    });
    ghost.removeAttribute('data-testid');
    ghost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ghost);
    drag.current = { pointer: e.pointerId, ghost, x0: e.clientX, y0: e.clientY, over: null };
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.ghost.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px)`;
    const over = whereAt(e.clientX, e.clientY);
    if (over !== d.over) {
      mark(d.over, false);
      mark(over, true);
      d.over = over;
    }
  };
  const end = (e: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    d.ghost.remove();
    mark(d.over, false);
    const over = drop ? (whereAt(e.clientX, e.clientY) ?? d.over) : null;
    const where = over
      ? parse(over.dataset.addWhere ?? over.getAttribute('data-add-where') ?? '')
      : null;
    if (where) void send(where, drop ? trackAt(e.clientX, e.clientY, tracks) : undefined);
  };

  const form = (
    <AddForm
      initial={title}
      options={options}
      verb={verb}
      roadmaps={roadmaps}
      initialRoadmap={rm}
      target={target}
      tracks={tracks}
      initialTrack={trk.props.value}
      onSubmit={async (t, w, r, k) => {
        if (r) setRm(r);
        if (k) trk.setValue(k);
        const ok = await onAdd(t, w, r, k ?? trk.only);
        if (ok) {
          rememberUsed({ roadmap: r, track: k ?? trk.only });
          setTitle('');
          setSheet(false);
        }
      }}
    />
  );

  if (phone)
    return (
      <>
        <Button variant="solid" data-testid="quick-add-open" onClick={() => setSheet(true)}>
          Add
        </Button>
        <Sheet
          open={sheet}
          title="Add an item"
          onClose={() => setSheet(false)}
          testId="quick-add-sheet"
        >
          {form}
        </Sheet>
      </>
    );

  return (
    <section
      data-testid="quick-add"
      aria-label="Quick add"
      className="flex flex-wrap items-center gap-2 rounded-[var(--simple-radius)] border border-dashed border-line-strong bg-surface px-3 py-2"
    >
      <label htmlFor="quick-add-title" className="text-sm font-semibold whitespace-nowrap">
        Add an item
      </label>
      {target && (
        <span data-testid="quick-add-target" className="text-sm whitespace-nowrap text-text2">
          to {target}
        </span>
      )}
      {ask && (
        <select
          ref={picker}
          aria-label="Roadmap"
          data-testid="quick-add-roadmap"
          value={rm}
          onChange={(e) => setRm(e.target.value)}
          aria-invalid={noRoadmap || undefined}
          aria-describedby={noRoadmap ? 'quick-add-roadmap-error' : undefined}
          className={`h-9 rounded-lg border bg-surface px-2 text-base text-text ${noRoadmap ? 'border-crit' : title.trim() && !chosen ? 'border-accent' : 'border-line-strong'}`}
        >
          <option value="">Which roadmap?</option>
          {roadmaps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      )}
      {trk.ask && <TrackPick {...trk.props} />}
      <input
        id="quick-add-title"
        ref={titleBox}
        value={title}
        maxLength={200}
        // qa-shell-24, fix4 qa-simple-roadmap-49: short enough to show whole with Ask open; the full words in its title.
        placeholder="Type a title, then drag it into place"
        title="Type a title, then drag it onto a quarter, a column or a goal"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          sendDefault();
        }}
        aria-invalid={noTitle || undefined}
        aria-describedby={noTitle ? 'quick-add-title-error' : undefined}
        className={`h-9 min-w-[16rem] flex-1 rounded-lg border bg-surface px-3 text-base text-text ${noTitle ? 'border-crit' : 'border-line-strong'}`}
      />
      <span
        role="button"
        tabIndex={ready ? 0 : -1}
        aria-disabled={!ready}
        data-testid="quick-add-chip"
        aria-label={
          ready
            ? 'Drag to place on a quarter, a column or a goal (Enter adds it now)'
            : title.trim()
              ? 'Choose a roadmap first'
              : 'Type a title first'
        }
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={(e) => end(e, true)}
        onPointerCancel={(e) => end(e, false)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          sendDefault();
        }}
        style={{ touchAction: 'none' }}
        className={`inline-flex h-9 max-w-[18rem] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold select-none ${
          ready
            ? 'cursor-grab border-accent bg-accent-soft text-accent-ink'
            : 'cursor-not-allowed border-line text-text2'
        }`}
      >
        <Icon name="grip" size={16} />
        {/* fix4 qa-simple-roadmap-49: the chip keeps saying what it is (the title is in the box beside it). */}
        <span className="truncate" title={title.trim() || undefined}>
          New item
        </span>
      </span>
      {/* qa-simple-roadmap-10: where Enter puts it, said before it is pressed. */}
      {ready && options[0] && (
        <span data-testid="quick-add-enter-hint" className="text-sm text-text2">
          Enter adds it to {options[0].label}
        </span>
      )}
      {(noTitle || noRoadmap || trk.invalid) && (
        <p role="alert" data-testid="quick-add-error" className="w-full text-sm text-crit">
          {noTitle && <span id="quick-add-title-error">Type a title</span>}
          {noTitle && noRoadmap && ' · '}
          {noRoadmap && <span id="quick-add-roadmap-error">Pick the roadmap it goes on</span>}
          {(noTitle || noRoadmap) && trk.invalid && ' · '}
          {trk.invalid && <span id="quick-add-track-error">Pick the track it goes on</span>}
        </p>
      )}
    </section>
  );
}
