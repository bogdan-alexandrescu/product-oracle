#!/usr/bin/env node
// Plants each defect of a JSON spec, runs the guard and expects it to go red, then restores
// the file, always (also on an error, Ctrl-C or SIGTERM). It refuses to start when a file it
// would change is dirty or untracked in git, or when the guard is red before any defect.
// The last line is the verdict: "MUTATE: OK ..." when every defect turned the guard red
// (exit 0), "MUTATE: FAIL ..." otherwise (exit 1).
//
//   node scripts/mutate.mjs <spec.json>     plant every defect in turn
//   node scripts/mutate.mjs --self-test     the self-test only
//
//   { "guard": "npx playwright test e2e/x.spec.ts --reporter=line --retries=0",
//     "cwd": ".",                  (optional: where the guard runs; default the current one)
//     "timeoutSeconds": 900,       (optional: a guard past it counts as not red, as does one killed by a signal)
//     "mutants": [
//       { "name": "drops the month-first date", "file": "lib/dates.ts", "find": "...", "replace": "..." },
//       { "name": "two edits at once", "edits": [{ "file": "...", "find": "...", "replace": "..." }] } ] }
//
// Paths are relative to the current directory; edits follow scripts/replace.mjs (exact text,
// "count" or "all"). Each guard run's output goes to $TMPDIR/mutate-<n>.log.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, plan } from './replace.mjs';

class Refusal extends Error {}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// A file is planted only when git can show it is clean, so a restore can be checked.
function refuseDirty(path) {
  const cwd = dirname(path);
  const rel = relative(cwd, path);
  if (git(['ls-files', '--error-unmatch', '--', rel], cwd).status !== 0)
    throw new Refusal(`${path} is not tracked by git`);
  const st = git(['status', '--porcelain', '--', rel], cwd);
  if (st.status !== 0 || st.stdout.trim()) throw new Refusal(`${path} has uncommitted changes`);
}

// The guard runs asynchronously in its own process group (#1607): the event loop stays free, so
// SIGINT and SIGTERM restore the files mid-guard, and a timeout, a signal or the guard's own end
// kills the whole group (a dev server, a browser), never only the shell, so nothing it started
// outlives it to serve the next mutant.
let guardPid = null;

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

function runGuard(spec, base, logPath) {
  return new Promise((done) => {
    const log = createWriteStream(logPath);
    const child = spawn(spec.guard, {
      shell: true,
      detached: true,
      cwd: resolve(base, spec.cwd ?? '.'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    guardPid = child.pid ?? null;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = spec.timeoutSeconds
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killGroup(child.pid);
        }, spec.timeoutSeconds * 1000)
      : null;
    child.on('error', (err) => log.write(`\n${err.message}\n`));
    // On the shell's exit its group goes too, so a child holding the pipes cannot keep it open.
    child.on('exit', () => child.pid && killGroup(child.pid));
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      guardPid = null;
      log.end(() => {
        if (timedOut) return done('timeout');
        // A guard killed by a signal (an OOM kill, Ctrl-C) never judged the defect: not red. The
        // shell reports a killed child as 128 + the signal (SIGINT 130, SIGKILL 137, SIGTERM 143).
        if (signal || [130, 137, 143].includes(status)) return done('killed');
        done(status === 0 ? 'green' : 'red');
      });
    });
  });
}

export async function run(
  specPath,
  { base = process.cwd(), logDir = tmpdir(), out = console.log } = {},
) {
  const originals = new Map();
  const restore = () => {
    for (const [path, text] of originals) writeFileSync(path, text);
  };
  const onSignal = (sig) => {
    if (guardPid) killGroup(guardPid);
    restore();
    out(`MUTATE: FAIL stopped by ${sig}; files restored`);
    process.exit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    let spec;
    try {
      spec = JSON.parse(readFileSync(resolve(base, specPath), 'utf8'));
    } catch (err) {
      throw new Refusal(`cannot read the spec ${specPath}: ${err.message}`);
    }
    if (typeof spec?.guard !== 'string' || !spec.guard)
      throw new Refusal('the spec has no "guard"');
    if (!Array.isArray(spec.mutants) || spec.mutants.length === 0)
      throw new Refusal('the spec has no mutants');
    const mutants = spec.mutants.map((m, i) => {
      const name = m?.name || `mutant ${i + 1}`;
      try {
        const files = plan(
          parseSpec(
            m.edits ?? [
              { file: m.file, find: m.find, replace: m.replace, count: m.count, all: m.all },
            ],
          ),
          base,
        );
        return { name, files };
      } catch (err) {
        throw new Refusal(`${name}: ${err.message}`);
      }
    });
    for (const m of mutants) for (const path of m.files.keys()) refuseDirty(path);

    const baseline = await runGuard(spec, base, join(logDir, 'mutate-baseline.log'));
    if (baseline !== 'green')
      throw new Refusal(
        `the guard is ${baseline} before any defect (log: ${join(logDir, 'mutate-baseline.log')})`,
      );

    const survived = [];
    for (const [i, m] of mutants.entries()) {
      const log = join(logDir, `mutate-${i + 1}.log`);
      try {
        for (const [path, f] of m.files) {
          originals.set(path, f.before);
          writeFileSync(path, f.after);
        }
        const result = await runGuard(spec, base, log);
        out(
          `${result === 'red' ? 'red     ' : 'NOT RED '} ${m.name}${result === 'timeout' ? ' (timed out)' : result === 'killed' ? ' (killed by a signal)' : ''} (log: ${log})`,
        );
        if (result !== 'red') survived.push(m.name);
      } finally {
        restore();
        originals.clear();
      }
    }
    for (const m of mutants)
      for (const [path, f] of m.files)
        if (readFileSync(path, 'utf8') !== f.before) throw new Error(`${path} was not restored`);

    if (survived.length)
      return {
        ok: false,
        line: `MUTATE: FAIL ${survived.length}/${mutants.length} planted defects left the guard green: ${survived.join('; ')}`,
      };
    return {
      ok: true,
      line: `MUTATE: OK ${mutants.length}/${mutants.length} planted defects turned the guard red; files restored`,
    };
  } catch (err) {
    restore();
    return {
      ok: false,
      line: `MUTATE: FAIL ${err instanceof Refusal ? 'refused: ' : ''}${err.message}`,
    };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const SELF_TEST = fileURLToPath(new URL('./mutate-self-test.mjs', import.meta.url));

async function main(args) {
  // The self-test is its own script, so it can import run() without an import cycle.
  if (args[0] === '--self-test')
    return spawnSync(process.execPath, [SELF_TEST], { stdio: 'inherit' }).status ?? 1;
  if (!args[0]) {
    console.log('MUTATE: FAIL usage: node scripts/mutate.mjs <spec.json> | --self-test');
    return 1;
  }
  const r = await run(args[0]);
  console.log(r.line);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
