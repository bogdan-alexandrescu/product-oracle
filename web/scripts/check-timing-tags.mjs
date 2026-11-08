#!/usr/bin/env node
// Fails when a mock spec measures elapsed time in a test whose title (or describe) lacks
// @timing. Timing specs run alone in CI's e2e-timing job; untagged, they run in the
// parallel mock-e2e shards and flake under load (playwright.config.ts: grepInvert).
//
// A test measures elapsed time when its body, or a helper function it calls (of the file, or
// imported from another file under e2e/; the mock API it drives is not the test), subtracts from the clock or reads performance.now(). The
// clock is Date.now(), performance.now(), new Date().getTime() / .valueOf(), +new Date(), or a
// variable set from one of them ("now() - start", "end - start" with const end = Date.now()).
// A coarse guard meant for the parallel shards says so with a "timing-check: coarse" comment
// in the test.
//
//   node scripts/check-timing-tags.mjs              self-test, then every e2e spec (not e2e/real)
//   node scripts/check-timing-tags.mjs --self-test  the self-test only
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TAG = "@timing";
const COARSE = "timing-check: coarse";

function isNowCall(node, objects = ["Date", "performance"]) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "now" &&
    ts.isIdentifier(node.expression.expression) &&
    objects.includes(node.expression.expression.text)
  );
}

/** `new Date()`, no arguments. */
function isNewDate(n) {
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && !n.arguments?.length;
}

/** A read of the clock: Date.now(), performance.now(), new Date().getTime() / .valueOf(), +new Date(), new Date(). */
function isClock(node) {
  const n = skipParens(node);
  if (isNowCall(n) || isNewDate(n)) return true;
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.PlusToken) return isNewDate(skipParens(n.operand));
  return (
    ts.isCallExpression(n) &&
    !n.arguments.length &&
    ts.isPropertyAccessExpression(n.expression) &&
    ["getTime", "valueOf"].includes(n.expression.name.text) &&
    isNewDate(skipParens(n.expression.expression))
  );
}

/** The callee's name as `helpers` keys it: `fn` or `ns.fn`, or null. */
function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  return null;
}

/**
 * Whether `node` measures time itself. `helpers` names the functions that do (`fn`, `ns.fn`);
 * `clocks` names the variables set from a clock read.
 */
function measures(node, helpers, clocks) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.MinusToken) {
      const left = skipParens(n.left);
      if (isClock(left) || (ts.isIdentifier(left) && clocks.has(left.text))) found = true;
    }
    if (isNowCall(n, ["performance"])) found = true;
    else if (ts.isCallExpression(n) && helpers.has(calleeName(n))) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function skipParens(n) {
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/** `test(...)`, `test.only(...)`, `test.describe(...)`, `test.describe.serial(...)`: its kind, or null. */
function testCallKind(node) {
  if (!ts.isCallExpression(node)) return null;
  const parts = [];
  let e = node.expression;
  while (ts.isPropertyAccessExpression(e)) {
    parts.unshift(e.name.text);
    e = e.expression;
  }
  if (!ts.isIdentifier(e) || e.text !== "test") return null;
  if (parts.length === 0 || (parts.length === 1 && ["only", "fixme", "fail", "slow"].includes(parts[0]))) return "test";
  if (parts[0] === "describe") return "describe";
  return null;
}

function titleOf(call, sf) {
  const arg = call.arguments[0];
  return arg ? arg.getText(sf) : "";
}

function readSource(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** A relative import's file under `root`: `spec` from `fromFile`, with .ts, .tsx or /index.ts; or null. */
function resolveImport(spec, fromFile, read, root) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  if (relative(root, base).startsWith("..")) return null;
  for (const p of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) if (/\.tsx?$/.test(p) && read(p) !== null) return p;
  return null;
}

/**
 * One file's view of what measures: its named functions that do (local name -> true), those
 * it exports (exported name -> true), and the imported ones it may call.
 */
function analyse(sf, fileName, read, root, cache) {
  // Imported functions that measure, under their local names.
  const helpers = new Set();
  const exportedFrom = (spec) => {
    const p = resolveImport(spec, fileName, read, root);
    return p ? measuringExports(p, read, root, cache) : new Set();
  };
  const reexports = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause && !st.importClause.isTypeOnly) {
      const exp = exportedFrom(st.moduleSpecifier.text);
      if (!exp.size) continue;
      const c = st.importClause;
      if (c.name && exp.has("default")) helpers.add(c.name.text);
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) for (const e of exp) helpers.add(`${b.name.text}.${e}`);
      else if (b) for (const el of b.elements) if (exp.has((el.propertyName ?? el.name).text)) helpers.add(el.name.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      const exp = exportedFrom(st.moduleSpecifier.text);
      if (!st.exportClause) {
        for (const e of exp) if (e !== "default") reexports.add(e);
      } else if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) if (exp.has((el.propertyName ?? el.name).text)) reexports.add(el.name.text);
    }
  }

  // Variables set from a clock read: const end = Date.now(); t0 = performance.now().
  const clocks = new Set();
  const findClocks = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isClock(n.initializer)) clocks.add(n.name.text);
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isClock(n.right)) clocks.add(n.left.text);
    ts.forEachChild(n, findClocks);
  };
  findClocks(sf);

  // The file's named functions (declarations and const arrows) that measure, to a fixpoint.
  const fns = new Map();
  const exported = new Map(); // exported name -> local name
  const isExported = (n) => ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export;
  const isDefault = (n) => ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Default;
  const collect = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      fns.set(n.name.text, n.body);
      if (isExported(n)) exported.set(isDefault(n) ? "default" : n.name.text, n.name.text);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fns.set(n.name.text, n.initializer.body);
      if (isExported(n)) exported.set(n.name.text, n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const el of st.exportClause.elements) exported.set(el.name.text, (el.propertyName ?? el.name).text);
    else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) exported.set("default", st.expression.text);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of fns) {
      if (helpers.has(name) || !measures(body, helpers, clocks)) continue;
      helpers.add(name);
      grew = true;
    }
  }
  const exports = new Set(reexports);
  for (const [name, local] of exported) if (helpers.has(local)) exports.add(name);
  return { helpers, clocks, exports };
}

/** The exported names of the file at `path` that measure (cycles read as none). */
function measuringExports(path, read, root, cache) {
  if (cache.has(path)) return cache.get(path);
  cache.set(path, new Set());
  const source = read(path);
  if (source === null) return cache.get(path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const { exports } = analyse(sf, path, read, root, cache);
  cache.set(path, exports);
  return exports;
}

/**
 * The tests of `source` that measure elapsed time without @timing: [{ line, title }].
 * Helpers are followed into files under `root` (the spec's folder by default); `read(path)`
 * gives an imported file's source, or null (the file system by default).
 */
export function untaggedTimingTests(source, fileName = "spec.ts", { root = dirname(resolve(fileName)), read = readSource } = {}) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { helpers, clocks } = analyse(sf, resolve(fileName), read, resolve(root), new Map());

  const out = [];
  const walk = (n, tagged) => {
    const kind = testCallKind(n);
    if (kind) {
      const title = titleOf(n, sf);
      const isTagged = tagged || title.includes(TAG);
      const body = n.arguments[n.arguments.length - 1];
      if (kind === "test") {
        const coarse = body && body.getFullText(sf).includes(COARSE);
        if (!isTagged && !coarse && body && measures(body, helpers, clocks)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, title });
        return;
      }
      for (const a of n.arguments.slice(1)) walk(a, isTagged);
      return;
    }
    ts.forEachChild(n, (c) => walk(c, tagged));
  };
  walk(sf, false);
  return out;
}

function selfTest() {
  const tagged = `test("a big list parses in linear time @timing", () => {
    const started = Date.now();
    parse(big);
    expect(Date.now() - started).toBeLessThan(1500);
  });`;
  const untagged = tagged.replace(" @timing", "");
  const cases = [
    ["tagged", tagged, 0],
    ["untagged", untagged, 1],
    ["tagged describe", `test.describe("big @timing", () => { ${untagged} });`, 0],
    ["untagged, through a helper", `async function paint() { const t0 = performance.now(); return 1; }\ntest("draws", async () => { expect(await paint()).toBeLessThan(2000); });`, 1],
    ["a deadline, not a measure", `test("waits", async () => { const opened = Date.now(); await wait(opened + 3000 - Date.now()); });`, 0],
    ["a deadline in a variable", `test("waits", async () => { const until = Date.now() + 3000; await wait(until - Date.now()); });`, 0],
    ["end - start, both variables", `test("parses", () => { const start = Date.now(); parse(big); const end = Date.now(); expect(end - start).toBeLessThan(1500); });`, 1],
    ["end - start, start reassigned", `test("parses", () => { let t0 = 0; t0 = Date.now(); parse(big); const end = Date.now(); expect(end - t0).toBeLessThan(1500); });`, 1],
    ["new Date().getTime() - t0", `test("parses", () => { const t0 = new Date().getTime(); parse(big); expect(new Date().getTime() - t0).toBeLessThan(1500); });`, 1],
    ["+new Date() - t0", `test("parses", () => { const t0 = +new Date(); parse(big); expect(+new Date() - t0).toBeLessThan(1500); });`, 1],
    ["date arithmetic, not the clock", `test("dates", () => { const at = new Date(now()); expect(new Date(at).getTime() - at.getTime()).toBe(0); });`, 0],
    ["coarse guard, marked", untagged.replace("parse(big);", `// ${COARSE}: a large regression still fails in the shards\n parse(big);`), 0],
  ];
  // Imported helpers: a spec at /e2e/a.spec.ts and the files it imports.
  const files = {
    "/e2e/clock.ts": `export async function paint(page) { const t0 = Date.now(); await page.goto("/"); return Date.now() - t0; }
      export const timed = async (fn) => { const t0 = new Date().getTime(); await fn(); return new Date().getTime() - t0; };
      function stamp() { const end = Date.now(); return end - started; }
      export { stamp as lap };
      export function open(page) { return page.goto("/"); }`,
    "/e2e/again.ts": `export { paint } from "./clock";`,
    "/e2e/vqa/a.spec.ts": "",
    "/lib/mock.ts": `export function due(job) { return Date.now() - job.started >= 2000; }`,
  };
  const read = (p) => files[p] ?? null;
  const spec = (imp, call) => `${imp}\ntest("draws", async ({ page }) => { expect(await ${call}).toBeLessThan(2000); });`;
  const imported = [
    ["imported helper", spec(`import { paint } from "./clock";`, "paint(page)"), 1],
    ["imported arrow helper", spec(`import { timed } from "./clock";`, "timed(() => 1)"), 1],
    ["imported, renamed on export", spec(`import { lap } from "./clock";`, "lap()"), 1],
    ["imported, renamed on import", spec(`import { paint as draw } from "./clock";`, "draw(page)"), 1],
    ["imported through a namespace", spec(`import * as clock from "./clock";`, "clock.paint(page)"), 1],
    ["imported through a re-export", spec(`import { paint } from "./again";`, "paint(page)"), 1],
    ["imported helper that does not measure", spec(`import { open } from "./clock";`, "open(page)"), 0],
    ["imported from a folder above", spec(`import { paint } from "../clock";`, "paint(page)"), 1, "/e2e/vqa/a.spec.ts"],
    ["the mock API, not the test", spec(`import { due } from "../lib/mock";`, "due(job)"), 0],
    ["imported helper, test tagged", spec(`import { paint } from "./clock";`, "paint(page)").replace('"draws"', '"draws @timing"'), 0],
  ];
  const failed = [
    ...cases.filter(([, src, want]) => untaggedTimingTests(src).length !== want).map(([name, src, want]) => [name, want, untaggedTimingTests(src).length]),
    ...imported
      .map(([name, src, want, file = "/e2e/a.spec.ts"]) => [name, want, untaggedTimingTests(src, file, { root: "/e2e", read }).length])
      .filter(([, want, got]) => got !== want),
  ];
  for (const [name, want, got] of failed) console.error(`self-test "${name}": want ${want} untagged, got ${got}`);
  return failed.length === 0;
}

function specs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "real" ? [] : specs(p);
    return d.name.endsWith(".spec.ts") ? [p] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!selfTest()) process.exit(1);
  if (process.argv.includes("--self-test")) {
    console.log("check-timing-tags: self-test passed");
    process.exit(0);
  }
  const web = join(fileURLToPath(import.meta.url), "..", "..");
  const bad = specs(join(web, "e2e")).flatMap((f) => untaggedTimingTests(readFileSync(f, "utf8"), f, { root: join(web, "e2e") }).map((t) => `${relative(web, f)}:${t.line} ${t.title}`));
  if (bad.length) {
    console.error(`These tests measure elapsed time; add ${TAG} to their titles so they run alone in e2e-timing:\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("check-timing-tags: every timing test is tagged @timing");
}
