import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { MODE_SCRIPT } from '@/components/ds/ModeSwitch';
import { THEME_SCRIPT } from '@/lib/theme';

/*
 * #1581: index.html sets the theme and the mode before the first paint, as the root layout did.
 * protects=a flash of the wrong theme or mode when lib/theme.ts or ModeSwitch changes alone;
 * fails_when=index.html's inline scripts are not THEME_SCRIPT and MODE_SCRIPT word for word;
 * no_claim=what the scripts do in a browser (the theme and mode specs drive that).
 */
test("index.html runs the theme and mode scripts as the app's own", () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]);
  expect(inline).toEqual([THEME_SCRIPT, MODE_SCRIPT]);
});
