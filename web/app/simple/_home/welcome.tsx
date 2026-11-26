'use client';

import { Link } from '@/lib/nav';
import { useState } from 'react';

import { dismissWelcome, useWelcomeCopy } from '@/app/home/_welcome';
import { HomeCard, HomeRow } from '@/app/simple/_home/cards';
import { Icon } from '@/components/ds/Icon';
import type { Schemas } from '@/lib/api/client';
import { useMe } from '@/lib/me';
import { errorMessage } from '@/lib/use-query';

/**
 * qa-onboarding-6: the A1 welcome (#140) on Simple's Home, so an invited member who lands in
 * Simple on their first sign-in (a commenter or a viewer by default) is welcomed as Detailed
 * welcomes them: what Oracle is for their role and their first three steps, each opening
 * Simple's page where one exists. Its words and its dismissal are Detailed's
 * (app/home/_welcome.tsx): dismissed here, it is gone in Detailed too, and the other way.
 *
 * Props:
 * - `show`: whether GET /v1/setup says to welcome the caller (`setup.welcome === true`).
 * - `onDismissed`: called once Dismiss was saved, to read /v1/setup again (or clear `welcome`).
 * - `setup`: the caller's Set up steps (/v1/setup): #1899, a step already done is ticked, and
 *   with every step done the card is gone.
 */
export function SimpleWelcome({
  show,
  onDismissed,
  setup,
}: {
  show: boolean;
  onDismissed: () => void;
  setup?: Schemas['SetupOut'];
}) {
  const { capsReady } = useMe();
  const copy = useWelcomeCopy('simple');
  const done = new Set((setup?.steps ?? []).filter((s) => s.done).map((s) => String(s.key)));
  const isDone = (s: { step?: string }) => !!s.step && done.has(s.step);
  // Gone once Dismiss is saved (a reload before that would bring it back); kept with the reason when it could not be.
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!show || gone || !capsReady || copy.steps.every(isDone)) return null;

  async function dismiss() {
    setBusy(true);
    setError(null);
    try {
      await dismissWelcome();
      setGone(true);
      onDismissed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HomeCard
      id="welcome"
      icon="home"
      title="Welcome to Oracle"
      extra={
        <button
          type="button"
          className="simple-button simple-button-quiet"
          onClick={() => void dismiss()}
          disabled={busy}
        >
          {busy ? 'Dismissing…' : 'Dismiss'}
        </button>
      }
    >
      <p className="simple-small">
        Oracle keeps the company&apos;s goals, PRDs and plan in one place, each tied to the evidence
        behind it.
      </p>
      <p data-testid="welcome-role" className="font-semibold">
        {copy.role}
      </p>
      <ol className="flex flex-col">
        {copy.steps.map((s, i) => (
          <HomeRow
            key={s.href}
            testId="welcome-step"
            lead={
              isDone(s) ? (
                <span
                  role="img"
                  aria-label="Done"
                  data-testid="welcome-step-done"
                  className="grid size-9 place-items-center rounded-full bg-pass-bg text-pass"
                >
                  <Icon name="check" size={20} />
                </span>
              ) : (
                <span
                  aria-hidden
                  className="tnum grid size-9 place-items-center rounded-full bg-accent-soft font-bold text-accent-ink"
                >
                  {i + 1}
                </span>
              )
            }
            title={
              <Link href={s.href} className="text-accent-ink hover:underline">
                {s.label}
              </Link>
            }
          />
        ))}
      </ol>
      {error && (
        <p role="alert" className="simple-small text-crit">
          Oracle could not dismiss the welcome. {error}
        </p>
      )}
    </HomeCard>
  );
}
