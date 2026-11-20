// #1569: does what is serving contain a commit? The deploy's containment check
// (scripts/deploy-serves.ts) asks each service's version route and answers with one of three
// exit states: 0 served, 1 not served, 2 could not ask.

export type Exit = 0 | 1 | 2;

/** One service's answer: the commit it serves, or why it could not be asked. */
export type Answer = { url: string; sha: string } | { url: string; error: string };

/** Whether ``served`` contains ``target`` (git's answer); null when git can not tell. */
export type Contains = (target: string, served: string) => boolean | null;

const SHA = /^[0-9a-f]{7,40}$/;

/** The commit a version route's body names ({"git_sha": ...}); null when it names none. */
export function servedSha(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const sha = (body as { git_sha?: unknown }).git_sha;
  return typeof sha === 'string' && SHA.test(sha.toLowerCase()) ? sha.toLowerCase() : null;
}

/** The same commit, when one is a prefix of the other (a short sha). */
function same(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * The verdict over every service: 1 when any serves a commit that does not contain
 * ``target`` (an answer, even if another could not be asked), else 2 when any could not be
 * asked or git could not tell, else 0. No service at all is 2.
 */
export function containment(
  target: string,
  answers: Answer[],
  contains: Contains,
): { exit: Exit; lines: string[] } {
  const want = target.toLowerCase();
  const lines: string[] = [];
  let notServed = false;
  let unknown = answers.length === 0;
  for (const a of answers) {
    if ('error' in a) {
      unknown = true;
      lines.push(`${a.url}: could not ask (${a.error})`);
      continue;
    }
    const verdict = same(a.sha, want) ? true : contains(want, a.sha);
    if (verdict === null) {
      unknown = true;
      lines.push(`${a.url}: serves ${a.sha}; could not tell whether it contains ${want}`);
    } else if (verdict) {
      lines.push(`${a.url}: serves ${a.sha}, which contains ${want}: served`);
    } else {
      notServed = true;
      lines.push(`${a.url}: serves ${a.sha}, which does not contain ${want}: not served`);
    }
  }
  return { exit: notServed ? 1 : unknown ? 2 : 0, lines };
}
