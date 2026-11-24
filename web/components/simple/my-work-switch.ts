// MOCK-HOOK: the whole file. URL switches for the My work mock-ups (#1798). Never merged.
import { MW_FORTY, MW_ITEMS } from '@/lib/api/mock/my-work';

/** MOCK-HOOK: one URL switch. */
export function mw(key: string): string | null {
  if (typeof window === 'undefined') return null; // MOCK-HOOK
  return new URLSearchParams(window.location.search).get(key); // MOCK-HOOK
}

/** MOCK-HOOK: whether the rails show a My work entry (MW1 a; the default when only MW2 or MW3 is set). */
export function myWorkEntry(): boolean {
  const v = mw('mw1'); // MOCK-HOOK
  return v === 'a' || (!v && !!(mw('mw2') || mw('mw3'))); // MOCK-HOOK
}

/** MOCK-HOOK: the rail's yellow count: late or at risk only, as the rail counts what waits. */
export function myWorkLate(): number {
  const c = mw('case'); // MOCK-HOOK
  if (c === 'none' || c === 'one') return 0; // MOCK-HOOK
  return (c === 'forty' ? MW_FORTY : MW_ITEMS).filter((i) => i.when === 0 || i.risk).length; // MOCK-HOOK
}

/** MOCK-HOOK: the "My work" count a rail entry shows. */
export function myWorkCount(): number {
  const c = mw('case'); // MOCK-HOOK
  return c === 'none' ? 0 : c === 'forty' ? 40 : c === 'one' ? 1 : MW_ITEMS.length; // MOCK-HOOK
}

