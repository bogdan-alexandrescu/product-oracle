/**
 * #1913: a proposal still waiting for a decision is worded as a request, never as done:
 * "Theo Brandt asks to change the owner of F-01 Sign in", not "Changed the owner of …".
 * The API's `asked` is the change as it would read once made (change_words.phrase); its first
 * word is turned back into the verb asked for.
 */
const VERB: Record<string, string> = {
  accepted: 'accept',
  added: 'add',
  archived: 'archive',
  asked: 'ask',
  changed: 'change',
  cleared: 'clear',
  confirmed: 'confirm',
  cut: 'cut',
  decided: 'decide',
  edited: 'edit',
  filed: 'file',
  gave: 'give',
  kept: 'keep',
  linked: 'link',
  made: 'make',
  marked: 'mark',
  merged: 'merge',
  moved: 'move',
  named: 'name',
  put: 'put',
  removed: 'remove',
  renamed: 'rename',
  reordered: 'reorder',
  restored: 'restore',
  set: 'set',
  took: 'take',
  unlinked: 'unlink',
  withdrew: 'withdraw',
};

/** `who` (a person, or "The meeting …") asking for `asked`; `via` says how it was asked (" through Ask Oracle"). */
export function requestWords(who: string, asked: string | null | undefined, via = ''): string {
  const text = (asked ?? '').trim();
  const [first, ...rest] = text.split(' ');
  const tail = rest.join(' ');
  if (first === 'proposed' && tail) return `${who} proposes${via} ${tail}`;
  const verb = VERB[first ?? ''];
  if (verb) return `${who} asks${via} to ${verb}${tail ? ` ${tail}` : ''}`;
  return text ? `${who} asks${via}: ${text}` : `${who} asks${via} for a change`;
}
