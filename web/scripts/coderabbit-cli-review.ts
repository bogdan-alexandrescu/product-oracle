// #1560: a local CodeRabbit review of this branch, with a verdict the exit code can be trusted
// for. Runs the CLI that `make agent-setup` installed (.agent-tools/bin/coderabbit) and prints
// one of: reviewed, did-not-review, reviewed-nothing-applicable, reviewed-incompletely.
//
//   node web/scripts/coderabbit-cli-review.ts [--base main] [--json] [-- <more coderabbit args>]
//   node web/scripts/coderabbit-cli-review.ts --from <dir>   adjudicate a saved run: <dir> holds
//                                                            stdout.txt, stderr.txt, exit.txt
//                                                            and files.txt
//
// Exits 0 for reviewed and reviewed-nothing-applicable, 1 otherwise. Never run in CI: the CLI
// sends the diff to CodeRabbit's service and needs a CodeRabbit sign-in.
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  adjudicate,
  exitCodeFor,
  formatVerdict,
  type CliReviewInput,
} from '../lib/coderabbitCliReview.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = join(ROOT, '.agent-tools', 'bin', 'coderabbit');
const TIMEOUT_MS = 30 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function fromSaved(dir: string): CliReviewInput {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const exit = read('exit.txt').trim();
  return {
    exitCode: exit === '' ? null : Number(exit),
    stdout: read('stdout.txt'),
    stderr: read('stderr.txt'),
    diffFiles: lines(read('files.txt')),
  };
}

function live(base: string, extra: string[]): CliReviewInput {
  if (!existsSync(CLI)) {
    console.error('coderabbit is not installed: run `make agent-setup` from the repository root.');
    process.exit(1);
  }
  let diffFiles: string[];
  try {
    diffFiles = lines(
      execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    console.log(
      `coderabbit review: did-not-review (0 findings)\n  - base ${base} not found: fetch it or pass --base`,
    );
    process.exit(1);
  }
  const run = spawnSync(CLI, ['review', '--agent', '--committed', '--base', base, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { exitCode: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', diffFiles };
}

const dash = process.argv.indexOf('--');
const extra = dash === -1 ? [] : process.argv.slice(dash + 1);
const saved = arg('--from');
const input = saved ? fromSaved(saved) : live(arg('--base') ?? 'main', extra);
const verdict = adjudicate(input);
console.log(
  process.argv.includes('--json') ? JSON.stringify(verdict, null, 2) : formatVerdict(verdict),
);
process.exitCode = exitCodeFor(verdict.state);
