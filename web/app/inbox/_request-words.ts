/**
 * #1913: a proposal still waiting for a decision is worded as a request, never as done:
 * "Theo Brandt asks to change the owner of F-01 Sign in", not "Changed the owner of …".
 * The API's `asked` is the change as it would read once made (change_words.phrase); its first
 * word is turned back into the verb asked for. The API words Home's and Decisions' waiting rows
 * by the same table (api/oracle/simple/change_words.py VERB, request_of), and so does the mock
 * (simple-change-words.ts); _request-words.test.ts holds the two tables equal.
 */
export const VERB: Record<string, string> = {
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

/** set_depends reads with its item first: "F-01 Sign in now depends on F-02 Billing page". */
const DEPENDS = /^(.+) (now|no longer) depends on (.+)$/;

/** The change's words as the thing asked for ("change the owner of F-01 Sign in"); null when its first word is no verb known. */
export function requestOf(asked: string): string | null {
  const [first, ...rest] = asked.split(' ');
  const tail = rest.join(' ');
  const verb = VERB[first ?? ''];
  if (verb) return `${verb}${tail ? ` ${tail}` : ''}`;
  const m = DEPENDS.exec(asked);
  if (m) return `make ${m[1]} ${m[2] === 'now' ? '' : 'no longer '}depend on ${m[3]}`;
  return null;
}

/** `who` (a person, or "The meeting …") asking for `asked`; `via` says how it was asked (" through Ask Oracle"). */
export function requestWords(who: string, asked: string | null | undefined, via = ''): string {
  const text = (asked ?? '').trim();
  const [first, ...rest] = text.split(' ');
  const tail = rest.join(' ');
  if (first === 'proposed' && tail) return `${who} proposes${via} ${tail}`;
  const request = requestOf(text);
  if (request) return `${who} asks${via} to ${request}`;
  return text ? `${who} asks${via}: ${text}` : `${who} asks${via} for a change`;
}
