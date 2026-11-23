/**
 * simple-speed: a read started before the part of the page that shows it is drawn, so it
 * loads beside the page's first read instead of after it.
 *
 * - `warmRead(key, load)` starts the read now and keeps it for WARM_MS.
 * - `takeWarm(key, load)` is the part's own read: the warmed one when there is one, taken
 *   once (a reload reads again), else `load()`. A warmed read that failed, or one older than
 *   WARM_MS, is never taken: the part reads for itself, as it did before.
 */

const WARM_MS = 15_000;

const warm = new Map<string, { at: number; read: Promise<unknown> }>();

/** Starts `load` now, for the part that will ask for `key`; a read already warm is kept. */
export function warmRead<T>(key: string, load: () => Promise<T>): void {
  const now = Date.now();
  for (const [k, w] of warm) if (now - w.at >= WARM_MS) warm.delete(k);
  if (warm.has(key)) return;
  const read = load();
  // Nobody may take it: its failure is still handled.
  read.catch(() => undefined);
  warm.set(key, { at: now, read });
}

/** The read warmed for `key` (once), else `load()`. */
export function takeWarm<T>(key: string, load: () => Promise<T>): Promise<T> {
  const w = warm.get(key);
  warm.delete(key);
  if (!w || Date.now() - w.at >= WARM_MS) return load();
  return (w.read as Promise<T>).catch(() => load());
}

/** Drops every warmed read (a test's clean start). */
export function forgetWarm(): void {
  warm.clear();
}
