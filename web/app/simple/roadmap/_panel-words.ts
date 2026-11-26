/**
 * panel-2 (#1906, #1907): the feature panel's read-only words, never the stored values its
 * editors change.
 */

/** #1907: the feature's own name as the panel's title: no "(P0)" priority tag and no PRD name
 * written before or after it ("Usage alerts: Weekly alert digest (P0)" reads "Weekly alert digest"). */
export function featureTitle(title: string, prd?: string | null): string {
  let out = title.replace(/\s*[([]\s*P[0-4]\s*[)\]]\s*$/i, '').trim();
  const name = prd?.trim();
  if (name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cut = out
      .replace(new RegExp(`^${esc}\\s*(?:[:·|/>»–—-]|\\s-)\\s*`, 'i'), '')
      .replace(new RegExp(`\\s*(?:[:·|–—-]\\s*${esc}|\\(${esc}\\))$`, 'i'), '')
      .trim();
    if (cut) out = cut;
  }
  return out || title;
}

/** #1907: a goal's target without the milestone shorthand at its end ("70% of teams (M2)" reads
 * "70% of teams"). */
export const targetWords = (target: string): string =>
  target.replace(/\s*[([]\s*(?:by\s+)?M\d+(?:\s*[,/&]\s*M\d+)*\s*[)\]]\s*$/i, '').trim() || target;

/** #1907: the notes Oracle writes when it makes a roadmap version, in plain words (a person's
 * own note reads as written). */
export function noteWords(note: string): string {
  const m = /^(carried )?from version \d+(, deferred|, changed in Simple)?$/i.exec(note.trim());
  if (m)
    return `Carried over from the last roadmap${
      m[2] ? (/deferred/i.test(m[2]) ? ', moved later' : ', changed in Simple') : ''
    }`;
  return /^added in Simple on version \d+$/i.test(note.trim()) ? 'Added in Simple' : note;
}
