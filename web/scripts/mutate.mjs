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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, plan } from "./replace.mjs";

class Refusal extends Error {}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// A file is planted only when git can show it is clean, so a restore can be checked.
function refuseDirty(path) {
  const cwd = dirname(path);
  const rel = relative(cwd, path);
  if (git(["ls-files", "--error-unmatch", "--", rel], cwd).status !== 0)
    throw new Refusal(`${path} is not tracked by git`);
  const st = git(["status", "--porcelain", "--", rel], cwd);
  if (st.status !== 0 || st.stdout.trim()) throw new Refusal(`${path} has uncommitted changes`);
}

function runGuard(spec, base, logPath) {
  const r = spawnSync(spec.guard, {
    shell: true,
    cwd: resolve(base, spec.cwd ?? "."),
    encoding: "utf8",
    timeout: spec.timeoutSeconds ? spec.timeoutSeconds * 1000 : undefined,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(logPath, `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}\n` : ""}`);
  if (r.error?.code === "ETIMEDOUT") return "timeout";
  // A guard killed by a signal (an OOM kill, Ctrl-C) never judged the defect: not red. The
  // shell reports a killed child as 128 + the signal (SIGINT 130, SIGKILL 137, SIGTERM 143).
  if (r.signal || [130, 137, 143].includes(r.status)) return "killed";
  return r.status === 0 ? "green" : "red";
}

export function run(specPath, { base = process.cwd(), logDir = tmpdir(), out = console.log } = {}) {
  const originals = new Map();
  const restore = () => {
    for (const [path, text] of originals) writeFileSync(path, text);
  };
  const onSignal = (sig) => {
    restore();
    out(`MUTATE: FAIL stopped by ${sig}; files restored`);
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let spec;
    try {
      spec = JSON.parse(readFileSync(resolve(base, specPath), "utf8"));
    } catch (err) {
      throw new Refusal(`cannot read the spec ${specPath}: ${err.message}`);
    }
    if (typeof spec?.guard !== "string" || !spec.guard) throw new Refusal('the spec has no "guard"');
    if (!Array.isArray(spec.mutants) || spec.mutants.length === 0) throw new Refusal("the spec has no mutants");
    const mutants = spec.mutants.map((m, i) => {
      const name = m?.name || `mutant ${i + 1}`;
      try {
        const files = plan(parseSpec(m.edits ?? [{ file: m.file, find: m.find, replace: m.replace, count: m.count, all: m.all }]), base);
        return { name, files };
      } catch (err) {
        throw new Refusal(`${name}: ${err.message}`);
      }
    });
    for (const m of mutants) for (const path of m.files.keys()) refuseDirty(path);

    const baseline = runGuard(spec, base, join(logDir, "mutate-baseline.log"));
    if (baseline !== "green")
      throw new Refusal(`the guard is ${baseline} before any defect (log: ${join(logDir, "mutate-baseline.log")})`);

    const survived = [];
    mutants.forEach((m, i) => {
      const log = join(logDir, `mutate-${i + 1}.log`);
      try {
        for (const [path, f] of m.files) {
          originals.set(path, f.before);
          writeFileSync(path, f.after);
        }
        const result = runGuard(spec, base, log);
        out(`${result === "red" ? "red     " : "NOT RED "} ${m.name}${result === "timeout" ? " (timed out)" : result === "killed" ? " (killed by a signal)" : ""} (log: ${log})`);
        if (result !== "red") survived.push(m.name);
      } finally {
        restore();
        originals.clear();
      }
    });
    for (const m of mutants)
      for (const [path, f] of m.files)
        if (readFileSync(path, "utf8") !== f.before) throw new Error(`${path} was not restored`);

    if (survived.length)
      return { ok: false, line: `MUTATE: FAIL ${survived.length}/${mutants.length} planted defects left the guard green: ${survived.join("; ")}` };
    return { ok: true, line: `MUTATE: OK ${mutants.length}/${mutants.length} planted defects turned the guard red; files restored` };
  } catch (err) {
    restore();
    return { ok: false, line: `MUTATE: FAIL ${err instanceof Refusal ? "refused: " : ""}${err.message}` };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "mutate-self-test-"));
  const logs = mkdtempSync(join(tmpdir(), "mutate-self-test-logs-"));
  const failures = [];
  const check = (name, cond) => cond || failures.push(name);
  const write = (name, text) => writeFileSync(join(dir, name), text);
  const read = (name) => readFileSync(join(dir, name), "utf8");
  const quiet = () => {};
  const spec = (s) => (write("spec.json", JSON.stringify(s)), "spec.json");
  // The guard: red unless lib.js still says both "keep" and "also".
  const guard = `node -e "const t=require('fs').readFileSync('lib.js','utf8'); process.exit(t.includes('keep') && t.includes('also') ? 0 : 1)"`;
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "self-test@example.com"], ["config", "user.name", "Self Test"]])
      git(args, dir);
    write("lib.js", "keep also\n");
    write(".gitignore", "spec.json\n");
    git(["add", "."], dir);
    git(["commit", "-qm", "base"], dir);

    let r = run(spec({ guard, mutants: [{ name: "drop keep", file: "lib.js", find: "keep", replace: "lose" }, { name: "drop also", edits: [{ file: "lib.js", find: "also", replace: "x" }] }] }), { base: dir, logDir: logs, out: quiet });
    check("every defect red: OK", r.ok && /^MUTATE: OK 2\/2/.test(r.line));
    check("restores the file", read("lib.js") === "keep also\n");

    r = run(spec({ guard, mutants: [{ name: "harmless", file: "lib.js", find: "\n", replace: " \n" }] }), { base: dir, logDir: logs, out: quiet });
    check("a defect that stays green: FAIL", !r.ok && /left the guard green: harmless/.test(r.line));
    check("restores after a survivor", read("lib.js") === "keep also\n");

    r = run(spec({ guard: "exit 1", mutants: [{ name: "drop keep", file: "lib.js", find: "keep", replace: "lose" }] }), { base: dir, logDir: logs, out: quiet });
    check("a red baseline is refused", !r.ok && /refused: the guard is red before any defect/.test(r.line));

    write("lib.js", "keep also\nedited\n");
    r = run(spec({ guard, mutants: [{ name: "drop keep", file: "lib.js", find: "keep", replace: "lose" }] }), { base: dir, logDir: logs, out: quiet });
    check("a dirty file is refused", !r.ok && /refused: .*uncommitted changes/.test(r.line));
    check("a dirty file is left as it was", read("lib.js") === "keep also\nedited\n");
    git(["checkout", "--", "lib.js"], dir);

    write("new.js", "keep\n");
    r = run(spec({ guard, mutants: [{ name: "untracked", file: "new.js", find: "keep", replace: "x" }] }), { base: dir, logDir: logs, out: quiet });
    check("an untracked file is refused", !r.ok && /not tracked by git/.test(r.line));

    r = run(spec({ guard, mutants: [{ name: "no match", file: "lib.js", find: "absent", replace: "x" }] }), { base: dir, logDir: logs, out: quiet });
    check("a defect that does not match is refused", !r.ok && /refused: no match: edit 1/.test(r.line));

    r = run(spec({ guard: `node -e "setTimeout(()=>{}, 60000)"`, timeoutSeconds: 1, mutants: [{ name: "slow", file: "lib.js", find: "keep", replace: "x" }] }), { base: dir, logDir: logs, out: quiet });
    check("a guard past its timeout is not green", !r.ok && /timeout before any defect/.test(r.line));

    const lost = "require('fs').readFileSync('lib.js','utf8').includes('lose')";
    for (const [name, killer] of [
      ["the shell", `node -e "process.exit(${lost} ? 1 : 0)" || kill -9 $$`],
      ["a child", `node -e "if (${lost}) process.kill(process.pid, 'SIGKILL')"`],
    ]) {
      const lines = [];
      r = run(spec({ guard: killer, mutants: [{ name: "drop keep", file: "lib.js", find: "keep", replace: "lose" }] }), { base: dir, logDir: logs, out: (l) => lines.push(l) });
      check(`a guard killed by a signal (${name}) is not red`, !r.ok && /left the guard green: drop keep/.test(r.line) && /^NOT RED .*\(killed by a signal\)/.test(lines[0] ?? ""));
      check(`restores after a killed guard (${name})`, read("lib.js") === "keep also\n");
    }

    r = run(spec({ guard, mutants: [] }), { base: dir, logDir: logs, out: quiet });
    check("an empty mutant list is refused", !r.ok && /no mutants/.test(r.line));
    check("the work tree is clean at the end", git(["status", "--porcelain"], dir).stdout.trim() === "?? new.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    const failures = selfTest();
    for (const f of failures) console.error(`self-test failed: ${f}`);
    console.log(failures.length ? `MUTATE SELF-TEST: FAIL ${failures.length}` : "MUTATE SELF-TEST: OK");
    process.exit(failures.length ? 1 : 0);
  }
  if (!args[0]) {
    console.log("MUTATE: FAIL usage: node scripts/mutate.mjs <spec.json> | --self-test");
    process.exit(1);
  }
  const r = run(args[0]);
  console.log(r.line);
  process.exit(r.ok ? 0 : 1);
}
