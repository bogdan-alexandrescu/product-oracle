import { afterEach, describe, expect, it, vi } from 'vitest';

import { forgetWarm, takeWarm, warmRead } from './warm';

/**
 * Card warm-reads: protects = a warmed read is started at once and handed to the part that asks
 * for it, once (a reload reads again); a failed or old one is never handed over; fails_when = a
 * part reads a second time what was warmed for it, keeps an old answer, or shows a warmed
 * failure; no_claim = which reads a page warms (its own spec).
 */
describe('warm reads', () => {
  afterEach(() => {
    forgetWarm();
    vi.useRealTimers();
  });

  it('starts the read at once and hands it over once', async () => {
    const load = vi.fn(() => Promise.resolve('first'));
    warmRead('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    const again = vi.fn(() => Promise.resolve('second'));
    await expect(takeWarm('k', again)).resolves.toBe('first');
    expect(again).not.toHaveBeenCalled();
    // A reload reads for itself.
    await expect(takeWarm('k', again)).resolves.toBe('second');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('keeps the first of two warm-ups of one key', async () => {
    const first = vi.fn(() => Promise.resolve(1));
    const second = vi.fn(() => Promise.resolve(2));
    warmRead('k', first);
    warmRead('k', second);
    expect(second).not.toHaveBeenCalled();
    await expect(takeWarm('k', second)).resolves.toBe(1);
  });

  it('reads again when the warmed read failed', async () => {
    warmRead('k', () => Promise.reject(new Error('down')));
    await expect(takeWarm('k', () => Promise.resolve('own'))).resolves.toBe('own');
  });

  it('never hands over a read older than its time', async () => {
    vi.useFakeTimers();
    warmRead('k', () => Promise.resolve('old'));
    vi.advanceTimersByTime(15_000);
    await expect(takeWarm('k', () => Promise.resolve('own'))).resolves.toBe('own');
  });

  it('reads for itself when nothing was warmed', async () => {
    await expect(takeWarm('none', () => Promise.resolve('own'))).resolves.toBe('own');
  });
});
