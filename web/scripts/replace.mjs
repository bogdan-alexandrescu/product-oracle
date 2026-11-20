#!/usr/bin/env node
// Exact find and replace from a JSON spec, all-or-nothing. Every edit is checked in memory
// first; one that does not match exactly as told fails the whole run and no file is written.
// The last line is the verdict: "REPLACE: OK ..." (exit 0) or "REPLACE: FAIL ..." (exit 1).
//
//   node scripts/replace.mjs <spec.json> [--dry-run]   apply the spec (or only check it)
//   node scripts/replace.mjs --self-test               the self-test only
//
// The spec is a list of edits, or { "edits": [...] }. Paths are relative to the current
// directory. Edits to one file apply in order, each to the text the one before it left.
//
//   [{ "file": "app/page.tsx", "find": "old text", "replace": "new text" },
//    { "file": "lib/a.ts", "find": "x", "replace": "y", "count": 3 },
//    { "file": "lib/b.ts", "find": "x", "replace": "y", "all": true }]
//
// "find" must occur exactly "count" times (default 1); with "all": true, at least once, and
// every occurrence is replaced. Text is matched as is: no regex, no trimming.
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class SpecError extends Error {}

function countOf(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

export function parseSpec(raw) {
  const edits = Array.isArray(raw) ? raw : raw?.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new SpecError("the spec has no edits");
  edits.forEach((e, i) => {
    const at = `edit ${i + 1}`;
    if (typeof e?.file !== "string" || !e.file) throw new SpecError(`${at}: "file" is missing`);
    if (typeof e.find !== "string" || !e.find) throw new SpecError(`${at}: "find" is missing or empty`);
    if (typeof e.replace !== "string") throw new SpecError(`${at}: "replace" is missing`);
    if (e.count !== undefined && !(Number.isInteger(e.count) && e.count > 0))
      throw new SpecError(`${at}: "count" must be a whole number above 0`);
    if (e.count !== undefined && e.all) throw new SpecError(`${at}: give "count" or "all", not both`);
  });
  return edits;
}

// Returns Map(path -> { before, after }) or throws SpecError naming the first edit that fails.
export function plan(edits, base = process.cwd()) {
  const files = new Map();
  edits.forEach((e, i) => {
    const path = resolve(base, e.file);
    if (!files.has(path)) {
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        throw new SpecError(`edit ${i + 1}: cannot read ${e.file}`);
      }
      files.set(path, { before: text, after: text });
    }
    const f = files.get(path);
    const n = countOf(f.after, e.find);
    if (e.all ? n === 0 : n !== (e.count ?? 1))
      throw new SpecError(
        `edit ${i + 1}: "find" occurs ${n} times in ${e.file}, expected ${e.all ? "at least 1" : (e.count ?? 1)}`,
      );
    f.after = f.after.split(e.find).join(e.replace);
  });
  return files;
}

// Writes every changed file through a temp file and a rename; restores all on a failed write.
export function apply(files) {
  const written = [];
  let current;
  try {
    for (const [path, f] of files) {
      if (f.after === f.before) continue;
      current = path;
      writeFileSync(`${path}.replace-tmp`, f.after);
      renameSync(`${path}.replace-tmp`, path);
      written.push(path);
    }
  } catch (err) {
    for (const path of written) writeFileSync(path, files.get(path).before);
    rmSync(`${current}.replace-tmp`, { force: true });
    throw err;
  }
  return written.length;
}

export function run(specPath, { dryRun = false, base = process.cwd() } = {}) {
  try {
    let raw;
    try {
      raw = JSON.parse(readFileSync(resolve(base, specPath), "utf8"));
    } catch (err) {
      throw new SpecError(`cannot read the spec ${specPath}: ${err.message}`);
    }
    const edits = parseSpec(raw);
    const files = plan(edits, base);
    const changed = [...files.values()].filter((f) => f.after !== f.before).length;
    if (dryRun) return { ok: true, line: `REPLACE: OK (dry run) ${edits.length} edits would change ${changed} files` };
    const n = apply(files);
    return { ok: true, line: `REPLACE: OK ${edits.length} edits, ${n} files written` };
  } catch (err) {
    return { ok: false, line: `REPLACE: FAIL ${err.message}; nothing written` };
  }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "replace-self-test-"));
  const failures = [];
  const check = (name, cond) => cond || failures.push(name);
  const write = (name, text) => writeFileSync(join(dir, name), text);
  const read = (name) => readFileSync(join(dir, name), "utf8");
  const spec = (edits) => (write("spec.json", JSON.stringify(edits)), "spec.json");
  try {
    write("a.txt", "one two two three");
    write("b.txt", "alpha beta");
    let r = run(spec([{ file: "a.txt", find: "one", replace: "1" }, { file: "b.txt", find: "beta", replace: "B" }]), { base: dir });
    check("applies edits across files", r.ok && read("a.txt") === "1 two two three" && read("b.txt") === "alpha B");
    check("verdict line", r.line === "REPLACE: OK 2 edits, 2 files written");

    write("a.txt", "one two two three");
    r = run(spec([{ file: "b.txt", find: "alpha", replace: "A" }, { file: "a.txt", find: "two", replace: "2" }]), { base: dir });
    check("an ambiguous find fails", !r.ok && /occurs 2 times/.test(r.line));
    check("all-or-nothing: no file written", read("b.txt") === "alpha B" && read("a.txt") === "one two two three");

    r = run(spec([{ file: "a.txt", find: "two", replace: "2", count: 2 }]), { base: dir });
    check("count matches", r.ok && read("a.txt") === "one 2 2 three");
    r = run(spec([{ file: "a.txt", find: "2", replace: "x", all: true }, { file: "a.txt", find: "x x", replace: "y" }]), { base: dir });
    check("all, then an edit on the text it left", r.ok && read("a.txt") === "one y three");
    r = run(spec([{ file: "a.txt", find: "missing", replace: "x", all: true }]), { base: dir });
    check("all with no match fails", !r.ok && read("a.txt") === "one y three");
    r = run(spec([{ file: "nope.txt", find: "a", replace: "b" }]), { base: dir });
    check("a missing file fails", !r.ok && /cannot read nope.txt/.test(r.line));
    r = run(spec([{ file: "a.txt", find: "", replace: "b" }]), { base: dir });
    check("an empty find fails", !r.ok);
    r = run(spec([]), { base: dir });
    check("an empty spec fails", !r.ok);
    r = run(spec({ edits: [{ file: "a.txt", find: "one", replace: "1" }] }), { base: dir, dryRun: true });
    check("dry run writes nothing", r.ok && read("a.txt") === "one y three" && /dry run/.test(r.line));
    write("c.txt", "$& $1 a.b");
    r = run(spec([{ file: "c.txt", find: "a.b", replace: "$&-$1" }]), { base: dir });
    check("text is literal, not a pattern", r.ok && read("c.txt") === "$& $1 $&-$1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    const failures = selfTest();
    for (const f of failures) console.error(`self-test failed: ${f}`);
    console.log(failures.length ? `REPLACE SELF-TEST: FAIL ${failures.length}` : "REPLACE SELF-TEST: OK");
    process.exit(failures.length ? 1 : 0);
  }
  const specPath = args.find((a) => !a.startsWith("--"));
  if (!specPath) {
    console.log("REPLACE: FAIL usage: node scripts/replace.mjs <spec.json> [--dry-run] | --self-test");
    process.exit(1);
  }
  const r = run(specPath, { dryRun: args.includes("--dry-run") });
  console.log(r.line);
  process.exit(r.ok ? 0 : 1);
}
