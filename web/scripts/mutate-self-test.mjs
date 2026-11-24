// The self-test of scripts/mutate.mjs; `node scripts/mutate.mjs --self-test` (and CI) starts it. It plants
// defects in a throwaway git repository under $TMPDIR and checks every verdict and restore,
// including a SIGTERM mid-guard and a timed-out guard's children (#1607).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './mutate.mjs';

const MUTATE = fileURLToPath(new URL('./mutate.mjs', import.meta.url));
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A process is alive when it exists and is not a zombie (a container's init may never reap one).
function alive(pid) {
  if (!existsSync('/proc')) {
    try {
      return process.kill(pid, 0);
    } catch {
      return false;
    }
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

async function waitFor(cond, ms) {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  return cond();
}

// Green on the clean file; planted ("lose"), it starts a child that would outlive the shell and
// waits on it, so only a kill of the whole group ends that child.
const HANGING = `node -e "process.exit(require('fs').readFileSync('lib.js','utf8').includes('lose') ? 1 : 0)" && exit 0; sleep 60 & echo $! > child.pid; wait`;

async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-self-test-'));
  const logs = mkdtempSync(join(tmpdir(), 'mutate-self-test-logs-'));
  const failures = [];
  const check = (name, cond) => cond || failures.push(name);
  const write = (name, text) => writeFileSync(join(dir, name), text);
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  const quiet = () => {};
  const spec = (s) => (write('spec.json', JSON.stringify(s)), 'spec.json');
  // The guard: red unless lib.js still says both "keep" and "also".
  const guard = `node -e "const t=require('fs').readFileSync('lib.js','utf8'); process.exit(t.includes('keep') && t.includes('also') ? 0 : 1)"`;
  try {
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'self-test@example.com'],
      ['config', 'user.name', 'Self Test'],
    ])
      git(args, dir);
    write('lib.js', 'keep also\n');
    write('.gitignore', 'spec.json\n');
    git(['add', '.'], dir);
    git(['commit', '-qm', 'base'], dir);

    let r = await run(
      spec({
        guard,
        mutants: [
          { name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' },
          { name: 'drop also', edits: [{ file: 'lib.js', find: 'also', replace: 'x' }] },
        ],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    check('every defect red: OK', r.ok && /^MUTATE: OK 2\/2/.test(r.line));
    check('restores the file', read('lib.js') === 'keep also\n');

    r = await run(
      spec({ guard, mutants: [{ name: 'harmless', file: 'lib.js', find: '\n', replace: ' \n' }] }),
      { base: dir, logDir: logs, out: quiet },
    );
    check(
      'a defect that stays green: FAIL',
      !r.ok && /left the guard green: harmless/.test(r.line),
    );
    check('restores after a survivor', read('lib.js') === 'keep also\n');

    r = await run(
      spec({
        guard: 'exit 1',
        mutants: [{ name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' }],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    check(
      'a red baseline is refused',
      !r.ok && /refused: the guard is red before any defect/.test(r.line),
    );

    write('lib.js', 'keep also\nedited\n');
    r = await run(
      spec({
        guard,
        mutants: [{ name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' }],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    check('a dirty file is refused', !r.ok && /refused: .*uncommitted changes/.test(r.line));
    check('a dirty file is left as it was', read('lib.js') === 'keep also\nedited\n');
    git(['checkout', '--', 'lib.js'], dir);

    write('new.js', 'keep\n');
    r = await run(
      spec({ guard, mutants: [{ name: 'untracked', file: 'new.js', find: 'keep', replace: 'x' }] }),
      { base: dir, logDir: logs, out: quiet },
    );
    check('an untracked file is refused', !r.ok && /not tracked by git/.test(r.line));

    r = await run(
      spec({
        guard,
        mutants: [{ name: 'no match', file: 'lib.js', find: 'absent', replace: 'x' }],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    check(
      'a defect that does not match is refused',
      !r.ok && /refused: no match: edit 1/.test(r.line),
    );

    r = await run(
      spec({
        guard: `node -e "setTimeout(()=>{}, 60000)"`,
        timeoutSeconds: 1,
        mutants: [{ name: 'slow', file: 'lib.js', find: 'keep', replace: 'x' }],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    check(
      'a guard past its timeout is not green',
      !r.ok && /timeout before any defect/.test(r.line),
    );

    const lost = "require('fs').readFileSync('lib.js','utf8').includes('lose')";
    for (const [name, killer] of [
      ['the shell', `node -e "process.exit(${lost} ? 1 : 0)" || kill -9 $$`],
      ['a child', `node -e "if (${lost}) process.kill(process.pid, 'SIGKILL')"`],
    ]) {
      const lines = [];
      r = await run(
        spec({
          guard: killer,
          mutants: [{ name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' }],
        }),
        { base: dir, logDir: logs, out: (l) => lines.push(l) },
      );
      check(
        `a guard killed by a signal (${name}) is not red`,
        !r.ok &&
          /left the guard green: drop keep/.test(r.line) &&
          /^NOT RED .*\(killed by a signal\)/.test(lines[0] ?? ''),
      );
      check(`restores after a killed guard (${name})`, read('lib.js') === 'keep also\n');
    }

    write('.gitignore', 'spec.json\nchild.pid\n');
    git(['commit', '-qam', 'ignore the pid file'], dir);
    r = await run(
      spec({
        guard: HANGING,
        timeoutSeconds: 1,
        mutants: [{ name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' }],
      }),
      { base: dir, logDir: logs, out: quiet },
    );
    const timedOutChild = Number(read('child.pid'));
    check('a timed-out guard is not red', !r.ok && /left the guard green: drop keep/.test(r.line));
    check(
      "a timed-out guard's children are killed",
      await waitFor(() => !alive(timedOutChild), 3000),
    );
    check('restores after a timed-out guard', read('lib.js') === 'keep also\n');
    rmSync(join(dir, 'child.pid'));

    const sigLogs = mkdtempSync(join(tmpdir(), 'mutate-self-test-sigterm-'));
    spec({
      guard: HANGING,
      mutants: [
        { name: 'drop keep', file: 'lib.js', find: 'keep', replace: 'lose' },
        { name: 'drop also', file: 'lib.js', find: 'also', replace: 'x' },
      ],
    });
    const proc = spawn(process.execPath, [MUTATE, 'spec.json'], {
      cwd: dir,
      env: { ...process.env, TMPDIR: sigLogs },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    const exited = new Promise((done) => proc.on('close', (code) => done(code)));
    const started = await waitFor(() => existsSync(join(dir, 'child.pid')), 10000);
    check('the SIGTERM guard started', started);
    const sigChild = started ? Number(read('child.pid')) : 0;
    proc.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(10000).then(() => 'hung')]);
    if (code === 'hung') proc.kill('SIGKILL');
    check('SIGTERM mid-guard stops the run', code === 1 && /stopped by SIGTERM/.test(stdout));
    check('SIGTERM mid-guard restores the file', read('lib.js') === 'keep also\n');
    check('SIGTERM mid-guard runs no further mutant', !existsSync(join(sigLogs, 'mutate-2.log')));
    check(
      "SIGTERM mid-guard kills the guard's children",
      await waitFor(() => !alive(sigChild), 3000),
    );
    rmSync(sigLogs, { recursive: true, force: true });
    rmSync(join(dir, 'child.pid'), { force: true });

    r = await run(spec({ guard, mutants: [] }), { base: dir, logDir: logs, out: quiet });
    check('an empty mutant list is refused', !r.ok && /no mutants/.test(r.line));
    check(
      'the work tree is clean at the end',
      git(['status', '--porcelain'], dir).stdout.trim() === '?? new.js',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
  return failures;
}

const failures = await selfTest();
for (const f of failures) console.error(`self-test failed: ${f}`);
console.log(failures.length ? `MUTATE SELF-TEST: FAIL ${failures.length}` : 'MUTATE SELF-TEST: OK');
process.exit(failures.length ? 1 : 0);
