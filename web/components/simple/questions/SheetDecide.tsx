'use client';

import { useState } from 'react';

import { api, unwrap } from '@/lib/api/client';
import { useQuery } from '@/lib/use-query';

/**
 * #1917: Decide on an open decision's sheet, the same call and rights as Home's inline Decide
 * (the decision's own `can_decide`): Decide shows its options, a click on one decides it.
 * Shown only to who may decide.
 */
export function SheetDecide({
  number,
  busy,
  act,
  onDecided,
}: {
  number: number;
  busy: boolean;
  act: (work: () => Promise<void>) => Promise<void>;
  onDecided: (label: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const one = useQuery(`decision-sheet-decide-${number}`, () =>
    unwrap(api.GET('/v1/decisions/{decision}', { params: { path: { decision: String(number) } } })),
  );
  const d = one.data;
  if (!d || !d.can_decide) return null;
  const decide = (key: string) =>
    act(async () => {
      const option = d.options.find((o) => o.key === key)!;
      await unwrap(
        api.POST('/v1/decisions/{decision}/decide', {
          params: { path: { decision: String(number) } },
          body: {
            option_key: key,
            rationale: `Decided on Simple's decision sheet: ${option.label}`,
            expected_outcome: option.summary || option.label,
            lock_version: d.lock_version,
          },
        }),
      );
      onDecided(option.label);
    });
  // The decide call needs two options (decisions.service.decide): with fewer, Edit adds them first.
  const few = d.options.length < 2;
  return (
    <>
      <button
        type="button"
        className="simple-button simple-button-primary"
        aria-expanded={picking}
        disabled={busy || few}
        title={few ? 'Add at least two options to decide' : undefined}
        onClick={() => setPicking((p) => !p)}
      >
        Decide
      </button>
      {picking && (
        <span role="group" aria-label="Decide" className="flex w-full flex-wrap gap-2">
          {d.options.map((o) => (
            <button
              key={o.key}
              type="button"
              className="simple-button"
              disabled={busy}
              onClick={() => void decide(o.key)}
            >
              {o.label}
            </button>
          ))}
        </span>
      )}
    </>
  );
}
