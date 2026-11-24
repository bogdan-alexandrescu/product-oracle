import { MOCK_SCENARIO_KEY } from '../lib/api/mock/server';

import { login } from './helpers';
import { expect, test } from './test';

/**
 * #1866 "Codes in run notes show with their name": on Simple › Decisions, a note a person left at a
 * run stop that writes goal, feature and milestone codes shows each code with its name beside it
 * (the names come from the Decisions read, the mock's twin of oracle.simple.note_codes); a code that
 * names nothing is left as written and the note's own words are not changed. Invented data
 * (the "run-note-codes" mock scenario).
 *
 * Card run-note-codes: protects = "Hold G-2 until F-104 has a date; M7 after." reads "Hold G-2
 * Faster first alert until F-104 Quiet hours has a date; M7 Pilot teams live after.", "F-999" stays
 * alone; fails_when = a code shows without its name, an unknown code gains one, or the note is
 * rewritten; no_claim = how the names are read (api/tests/test_simple_decisions_runs.py).
 */
test('a run note shows each code it writes with its name', async ({ page }) => {
  await page.addInitScript(([key, s]) => localStorage.setItem(key, s), [
    MOCK_SCENARIO_KEY,
    'run-note-codes',
  ] as const);
  await login(page);
  await page.goto('/simple/decisions');
  const runs = page.getByRole('region', { name: 'Runs' });
  const row = runs.getByTestId('run-stop-row').filter({ hasText: 'PRD review: approved' });
  const note = row.getByTestId('run-stop-note');
  await expect(note).toHaveText(
    'Hold G-2 Faster first alert until F-104 Quiet hours has a date; M7 Pilot teams live after. F-999 can wait.',
  );
  await expect(note.getByTestId('run-note-code')).toHaveText([
    'G-2 Faster first alert',
    'F-104 Quiet hours',
    'M7 Pilot teams live',
  ]);
  // A note with no code reads as written.
  await expect(runs.getByTestId('run-stop-row').first().getByTestId('run-stop-note')).toHaveText(
    'Keep the weekly digest; leave text messages for later.',
  );
});
