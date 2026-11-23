import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type * as Words from '@/lib/words';

import { CodeTag, codeTagRoom } from './CodeChip';

/*
 * priorities-words (words-cut): the Goal column puts a goal's name beside its code when the
 * code tag's measured room and the name's longest word fit. protects = the tag is measured at
 * the type-scale step it is drawn at; fails_when = the two differ (measured at 13 px, drawn at
 * 14 px: "Conversio / n" in the fallback fonts); no_claim = how the column looks (Playwright's
 * priorities-words spec drives the page).
 */
vi.mock('@/lib/words', async (real) => ({
  ...(await real<typeof Words>()),
  // A stand-in font: every letter 0.6 of the size, as a monospace face.
  textWidth: (text: string, _weight: number, size: number) => text.length * size * 0.6,
}));

test("the code tag's room is measured at the size the tag is drawn", () => {
  render(<CodeTag code="G-B" />);
  const step = screen.getByTestId('code-tag').className.match(/\btext-(xs|sm|base)\b/)?.[1];
  const css = readFileSync(join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8');
  const px = Number(css.match(new RegExp(`--text-${step}:\\s*(\\d+)px`))?.[1]);
  expect(px).toBeGreaterThan(0);
  // The text, 7 px each side, and the chip's 6 px gap.
  expect(codeTagRoom('G-B')).toBeCloseTo(3 * px * 0.6 + 14 + 6);
});
