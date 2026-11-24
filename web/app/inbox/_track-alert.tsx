'use client';
// inbox-ux (#1784, #1785, #1786): a track alert's parts on the Inbox: its item named with its code,
// its reasons in one line (all of them on expand), one primary action with the rest in a menu, and
// the track's status in the Roadmap's words.

import { useId, useState } from 'react';

import { Button, LinkButton } from '@/components/ds';
import { FeatureName } from '@/components/simple/FeatureName';
import {
  acceptTrackAlertDate,
  alertSentence,
  firstSafeAction,
  keepTrackAlert,
  planHref,
  reviewHref,
  type TrackAlertOut,
} from '@/lib/api/track-alerts';
import { errorMessage } from '@/lib/use-query';

type Act = (key: string, call: () => Promise<unknown>) => Promise<void>;

/** #1785: a track's status as the Simple Roadmap words it: On track, else Needs a look. */
export const trackStatus = (health: string | null | undefined) =>
  health === 'on_track' ? 'On track' : 'Needs a look';

/** The alert's item name with no leading code of its own ("F-31 Alert routing" reads "Alert routing"). */
function itemName(a: TrackAlertOut): string {
  const title = a.item_title ?? a.item_key ?? a.prd.title;
  const code = a.item_code;
  return code && title.startsWith(`${code} `) ? title.slice(code.length + 1) : title;
}

/** The alert's item as people read it, its code first ("F-31 Alert routing"). */
export const alertTitle = (a: TrackAlertOut) =>
  a.item_code ? `${a.item_code} ${itemName(a)}` : itemName(a);

/** #1786: the alert's item, its code with its name; an item with no code is flagged. */
export function AlertItem({ a }: { a: TrackAlertOut }) {
  return (
    <span className="truncate" data-testid="child-title" title={alertTitle(a)}>
      {a.item_key ? (
        <FeatureName item={{ code: a.item_code ?? null, title: itemName(a) }} />
      ) : (
        itemName(a)
      )}
    </span>
  );
}

/** #1786: the alert's reasons in one line, the first; the rest on expand, every one in full. */
export function AlertSummary({ a }: { a: TrackAlertOut }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // A stale alert's reasons are joined by "; " (staleness.detail_for_reader); other alerts are one sentence.
  const parts = a.kind === 'stale' ? alertSentence(a).split('; ') : [alertSentence(a)];
  const more = parts.length - 1;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-sm text-text2">
      <span
        id={id}
        className={open ? 'min-w-0 whitespace-normal' : 'block min-w-0 truncate'}
        title={parts.join('; ')}
        data-testid="track-alert-detail"
      >
        {open ? parts.join('; ') : parts[0]}
      </span>
      {more > 0 && (
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? 'Show less' : `Show ${more} more`}
          className="h-6! flex-none px-1.5!"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '−' : `+${more}`}
        </Button>
      )}
    </span>
  );
}

/** #1784: a track alert's one primary action; Keep watching and Open in a menu. */
export function TrackAlertActions({
  a,
  busy,
  act,
}: {
  a: TrackAlertOut;
  busy: string | null;
  act: Act;
}) {
  const [keeping, setKeeping] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = alertTitle(a);
  const first = firstSafeAction(a);
  const run = (key: string, call: () => Promise<unknown>) => {
    setError(null);
    void act(key, () => call().catch((e) => setError(errorMessage(e))));
  };
  const errorLine = error && (
    <span
      role="alert"
      className="basis-full text-right text-sm text-crit max-[600px]:text-left"
      data-testid="child-error"
    >
      {error}
    </span>
  );
  if (keeping)
    return (
      <KeepForm
        busy={busy}
        errorLine={errorLine}
        onCancel={() => setKeeping(false)}
        onKeep={(note) => run(`keep-${a.id}`, () => keepTrackAlert(a.id, note))}
      />
    );
  const keep = a.actions.includes('keep');
  return (
    <span
      data-child-actions
      className="inline-flex flex-wrap items-center justify-end gap-1.5 max-[600px]:w-full max-[600px]:[&>*]:w-full"
    >
      {first === 'accept_date' && (
        <Button
          disabled={busy !== null}
          aria-label={`Accept new date for ${title}`}
          onClick={() => run(`accept-${a.id}`, () => acceptTrackAlertDate(a.id))}
        >
          Accept new date
        </Button>
      )}
      {first === 'review' && (
        <LinkButton href={reviewHref(a)} aria-label={`Review ${title}`}>
          Review
        </LinkButton>
      )}
      {first === 'keep' && (
        <Button
          disabled={busy !== null}
          aria-label={`Keep watching ${title}`}
          onClick={() => setKeeping(true)}
        >
          Keep watching
        </Button>
      )}
      {first === null && (
        <LinkButton href={planHref(a)} aria-label={`Open ${title}`}>
          Open
        </LinkButton>
      )}
      {first !== null && (
        // The row's menu opens in the row: a panel over the table would be cut by its scroll box.
        <Button
          icon="more"
          aria-label={`More actions for ${title}`}
          title={`More actions for ${title}`}
          aria-expanded={more}
          className="w-8 px-0"
          onClick={() => setMore((m) => !m)}
        />
      )}
      {more && (
        <span
          className="flex basis-full justify-end gap-1.5 max-[600px]:flex-col"
          role="menu"
          aria-label={`More actions for ${title}`}
          onKeyDown={(e) => e.key === 'Escape' && setMore(false)}
        >
          {first !== 'keep' && keep && (
            <Button
              variant="ghost"
              role="menuitem"
              disabled={busy !== null}
              onClick={() => {
                setMore(false);
                setKeeping(true);
              }}
            >
              Keep watching
            </Button>
          )}
          <LinkButton variant="ghost" role="menuitem" href={planHref(a)}>
            Open in Plan
          </LinkButton>
        </span>
      )}
      {errorLine}
    </span>
  );
}

/** Keep watching's optional note, then Keep watching or Cancel. */
function KeepForm({
  busy,
  errorLine,
  onCancel,
  onKeep,
}: {
  busy: string | null;
  errorLine: React.ReactNode;
  onCancel: () => void;
  onKeep: (note: string | null) => void;
}) {
  const [note, setNote] = useState('');
  const fieldId = useId();
  return (
    <form
      data-child-actions
      data-testid="track-keep-field"
      className="flex w-full flex-col items-stretch gap-1.5 py-1 text-left whitespace-normal"
      onSubmit={(e) => {
        e.preventDefault();
        onKeep(note.trim() || null);
      }}
    >
      <label htmlFor={fieldId} className="text-sm leading-4 font-semibold text-text2">
        Note (optional)
      </label>
      <input
        id={fieldId}
        autoFocus
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        className="h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface px-2 text-sm"
      />
      {errorLine}
      <span className="flex justify-end gap-1.5 max-[600px]:flex-col">
        <Button type="submit" disabled={busy !== null} className="max-[600px]:w-full">
          Keep watching
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={onCancel}
          className="max-[600px]:w-full"
        >
          Cancel
        </Button>
      </span>
    </form>
  );
}
