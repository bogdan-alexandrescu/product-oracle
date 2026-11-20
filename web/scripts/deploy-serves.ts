// #1569: is a commit served? The deploy job's containment check (.github/workflows/ci.yml).
//
//   node web/scripts/deploy-serves.ts <sha> <version-url>... [--wait <seconds>]
//
// Asks each URL (a service's /version route: {"git_sha": ...}) and exits 0 when every service
// serves the commit or a later one that contains it (git merge-base --is-ancestor, in the
// current checkout), 1 when one does not, 2 when one could not be asked (no answer, not 200,
// no commit in the body, or git could not tell). --wait asks again every 10 s while the
// answer is not 0, for up to that many seconds (a new revision taking its traffic).
// ORACLE_VERSION_TOKEN, when set, is sent to every URL as "Authorization: Bearer <token>" (a
// Google ID token for the service's IAP audience).
import { spawnSync } from 'node:child_process';
import { containment } from '../lib/deployContainment.ts';
import type { Answer } from '../lib/deployContainment.ts';
import { servedSha } from '../lib/deployContainment.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--wait');
const wait = at === -1 ? 0 : /^\d+$/.test(args[at + 1] ?? '') ? Number(args[at + 1]) : NaN;
const [target, ...urls] = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
if (!target || !/^[0-9a-f]{7,40}$/i.test(target) || urls.length === 0 || !Number.isFinite(wait)) {
  console.error('usage: deploy-serves.ts <sha> <version-url>... [--wait <seconds>]');
  process.exit(2);
}

function contains(sha: string, served: string): boolean | null {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, served], { stdio: 'ignore' });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}

const token = process.env.ORACLE_VERSION_TOKEN;
const headers: Record<string, string> = { 'cache-control': 'no-cache' };
if (token) headers.authorization = `Bearer ${token}`;

async function ask(url: string): Promise<Answer> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers });
    if (r.status !== 200) return { url, error: `HTTP ${r.status}` };
    const sha = servedSha(await r.json().catch(() => null));
    return sha ? { url, sha } : { url, error: 'no commit in the answer' };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

const until = Date.now() + wait * 1000;
for (;;) {
  const { exit, lines } = containment(target, await Promise.all(urls.map(ask)), contains);
  if (exit === 0 || Date.now() + 10_000 > until) {
    for (const line of lines) console.log(line);
    console.log(['served', 'not served', 'could not ask'][exit]);
    process.exit(exit);
  }
  await new Promise((done) => setTimeout(done, 10_000));
}
