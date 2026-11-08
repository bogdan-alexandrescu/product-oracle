#!/usr/bin/env node
// Fails when a mock spec measures elapsed time in a test whose title (or describe) lacks
// @timing. Timing specs run alone in CI's e2e-timing job; untagged, they run in the
// parallel mock-e2e shards and flake under load (playwright.config.ts: grepInvert).
//
// A test measures elapsed time when its body, or a helper function it calls (of the file, or
// imported from another file under e2e/; the mock API it drives is not the test), subtracts from the clock or reads performance.now(). The
// clock is Date.now(), performance.now(), new Date().getTime() / .valueOf(), +new Date(), a
// variable set from one of them in its own scope ("end - start" with const end = Date.now()),
// or a call of a function that returns one (const now = () => Date.now()); new Date() counts
// only when another clock read is taken from it ("new Date() - t0"), never in plain date maths.
// A coarse guard meant for the parallel shards says so with a "timing-check: coarse" comment
// in the test; it passes only when every bound it sets on a measured value (toBeLessThan,
// toBeLessThanOrEqual, toBeGreaterThan) is a literal of at least 1000 ms.
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

/** `Date.now`, `performance.now`, `process.hrtime` or `process.hrtime.bigint`, uncalled. */
function isClockRef(n) {
  n = skipParens(n);
  if (!ts.isPropertyAccessExpression(n)) return false;
  const of = skipParens(n.expression);
  const name = n.name.text;
  if (ts.isIdentifier(of)) return (name === "now" && ["Date", "performance"].includes(of.text)) || (name === "hrtime" && of.text === "process");
  return name === "bigint" && ts.isPropertyAccessExpression(of) && of.name.text === "hrtime" && ts.isIdentifier(of.expression) && of.expression.text === "process";
}

/** `process.hrtime(t0)`: the time since t0, a measure in itself. */
function isHrtimeSince(n) {
  return ts.isCallExpression(n) && n.arguments.length > 0 && isClockRef(n.expression) && skipParens(n.expression).name.text === "hrtime";
}

/** `new Date()`, no arguments. */
function isNewDate(n) {
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Date" && !n.arguments?.length;
}

// How surely a value is a clock read: a timestamp, or a `new Date()` that is one only when
// another clock read is taken from it (or it from one); plain date maths is not timing.
const STRONG = 2;
const WEAK = 1;

/**
 * Whether `node` reads the clock, and how surely: STRONG for Date.now(), performance.now(),
 * new Date().getTime() / .valueOf(), +new Date(); WEAK for new Date(); 0 for none. A variable
 * set from a clock read, or a call of a function that returns one, reads as that read.
 * `clocks` holds the file's checker and its clock variables and functions, by declaration.
 */
function clockKind(node, clocks) {
  const n = skipParens(node);
  if (ts.isCallExpression(n) && isClockRef(n.expression)) return isHrtimeSince(n) ? 0 : STRONG;
  if (isNewDate(n)) return WEAK;
  if (ts.isElementAccessExpression(n)) return clockKind(n.expression, clocks); // process.hrtime()[0]
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.PlusToken)
    return isNewDate(skipParens(n.operand)) ? STRONG : clockKind(n.operand, clocks);
  if (ts.isCallExpression(n) && !n.arguments.length && ts.isPropertyAccessExpression(n.expression) && ["getTime", "valueOf"].includes(n.expression.name.text)) {
    const of = skipParens(n.expression.expression);
    return isNewDate(of) ? STRONG : clockKind(of, clocks);
  }
  if (ts.isIdentifier(n)) return clocks.vars.get(symbolOf(n, clocks)) ?? 0;
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) return clocks.fns.get(symbolOf(n.expression, clocks)) ?? 0;
  return 0;
}

function symbolOf(id, clocks) {
  return clocks.checker.getSymbolAtLocation(id);
}

/** A checker for `sf` alone: it tells which declaration a name means, scope by scope. */
function checkerFor(sf) {
  const host = {
    getSourceFile: () => sf,
    fileExists: () => true,
    readFile: () => undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  return ts.createProgram({ rootNames: [sf.fileName], options: { noLib: true, noResolve: true, types: [] }, host }).getTypeChecker();
}

/** The clock reads `fn` returns (the surest of them), or 0. */
function returnKind(fn, clocks) {
  if (!fn.body) return 0;
  if (!ts.isBlock(fn.body)) return clockKind(fn.body, clocks);
  let kind = 0;
  const visit = (n) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) kind = Math.max(kind, clockKind(n.expression, clocks));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return kind;
}

/**
 * `sf`'s clock variables (const end = Date.now(); t0 = performance.now()), clock functions
 * (const now = () => Date.now(); const clock = Date.now) and deadlines (const until = Date.now()
 * + 3000), each by its declaration, so a name in another scope is not one.
 */
function findClocks(sf) {
  const clocks = { checker: checkerFor(sf), vars: new Map(), fns: new Map(), deadlines: new Map() };
  let grew = true;
  const raise = (map, id, kind) => {
    const s = kind && symbolOf(id, clocks);
    if (s && kind > (map.get(s) ?? 0)) {
      map.set(s, kind);
      grew = true;
    }
  };
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = skipParens(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) raise(clocks.fns, n.name, returnKind(init, clocks));
      else if (isClockAlias(init)) raise(clocks.fns, n.name, STRONG);
      else {
        raise(clocks.vars, n.name, clockKind(init, clocks));
        raise(clocks.deadlines, n.name, isDeadline(init, clocks) ? STRONG : 0);
      }
    } else if (ts.isFunctionDeclaration(n) && n.name) raise(clocks.fns, n.name, returnKind(n, clocks));
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      raise(clocks.vars, n.left, clockKind(n.right, clocks));
      raise(clocks.deadlines, n.left, isDeadline(n.right, clocks) ? STRONG : 0);
    }
    ts.forEachChild(n, visit);
  };
  while (grew) {
    grew = false;
    visit(sf);
  }
  return clocks;
}

/** `Date.now` or `performance.now.bind(performance)`: a clock under another name. */
function isClockAlias(n) {
  n = skipParens(n);
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "bind") n = n.expression.expression;
  return isClockRef(n);
}

/** A deadline: a timestamp plus or minus a budget (Date.now() + 3000, t0 - 50), or a variable set to one. */
function isDeadline(node, clocks) {
  const n = skipParens(node);
  if (ts.isIdentifier(n)) return clocks.deadlines.has(symbolOf(n, clocks));
  if (!ts.isBinaryExpression(n)) return false;
  const [l, r] = [clockKind(n.left, clocks), clockKind(n.right, clocks)];
  if (n.operatorToken.kind === ts.SyntaxKind.PlusToken) return (l === STRONG && !r) || (r === STRONG && !l);
  return n.operatorToken.kind === ts.SyntaxKind.MinusToken && l === STRONG && !r;
}

const COMPARISONS = [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken];

/** Whether `n` (outside nested functions) throws or calls expect(). */
function asserts(n) {
  if (!n || ts.isFunctionLike(n)) return false;
  if (ts.isThrowStatement(n) || (ts.isCallExpression(n) && expected(n) !== null)) return true;
  return !!ts.forEachChild(n, asserts);
}

/**
 * Whether a comparison of the clock with a deadline only waits: it is the condition of a loop,
 * or of an if (or ?:) none of whose branches throws or calls expect(), so it stops a poll
 * rather than failing the test on the time.
 */
function onlyWaits(cmp) {
  let c = cmp;
  let p = c.parent;
  const passes = (x) =>
    ts.isParenthesizedExpression(x) ||
    (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(x) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(x.operatorToken.kind));
  while (p && passes(p)) [c, p] = [p, p.parent];
  if (!p) return false;
  if ((ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === c) return true;
  if (ts.isForStatement(p) && p.condition === c) return true;
  if (ts.isIfStatement(p) && p.expression === c) return !asserts(p.thenStatement) && !asserts(p.elseStatement);
  if (ts.isConditionalExpression(p) && p.condition === c) return !asserts(p.whenTrue) && !asserts(p.whenFalse);
  return false;
}

/** The callee's name as `helpers` keys it: `fn` or `ns.fn`, or null. */
function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  return null;
}

/**
 * Whether the node `n` is itself a measure (not counting what is inside it). `helpers` names
 * the functions that measure (`fn`, `ns.fn`); `clocks` is the file's clock reads (findClocks).
 * A clock read less anything ("now() - start") measures; a deadline less the clock ("until -
 * Date.now()") does not. The clock checked against a deadline measures (expect(Date.now())
 * .toBeLessThan(until), if (Date.now() > until) throw ...), unless the check only stops a poll.
 */
function measureAt(n, helpers, clocks) {
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.MinusToken) {
      const left = clockKind(n.left, clocks);
      if (left === STRONG || (left && clockKind(n.right, clocks))) return true;
    } else if (op === ts.SyntaxKind.PlusToken) {
      // -start + Date.now()
      const negated = (x) => ((x = skipParens(x)), ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken ? clockKind(x.operand, clocks) : 0);
      if ((negated(n.left) && clockKind(n.right, clocks)) || (negated(n.right) && clockKind(n.left, clocks))) return true;
    } else if (COMPARISONS.includes(op)) {
      const vs = (a, b) => clockKind(a, clocks) && isDeadline(b, clocks);
      if ((vs(n.left, n.right) || vs(n.right, n.left)) && !onlyWaits(n)) return true;
    }
    return false;
  }
  if (!ts.isCallExpression(n)) return false;
  if (isNowCall(n, ["performance"]) || isHrtimeSince(n) || helpers.has(calleeName(n))) return true;
  // expect(Date.now()).toBeLessThan(until), expect.poll(() => Date.now())..., expect(t0 + 50).toBeGreaterThan(Date.now())
  if (ts.isPropertyAccessExpression(n.expression) && [...BOUNDS, "toBeGreaterThanOrEqual"].includes(n.expression.name.text) && n.arguments[0]) {
    const x = expected(n);
    if (!x) return false;
    const subject = ts.isArrowFunction(x) || ts.isFunctionExpression(x) ? returnKind(x, clocks) : clockKind(x, clocks);
    const b = n.arguments[0];
    return !!((subject && isDeadline(b, clocks)) || (isDeadline(x, clocks) && clockKind(b, clocks)));
  }
  return false;
}

/** Whether `node`, or anything in it, measures time (measureAt). */
function measures(node, helpers, clocks) {
  const visit = (n) => measureAt(n, helpers, clocks) || !!ts.forEachChild(n, visit);
  return visit(node);
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

  const clocks = findClocks(sf);

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

/** Every comment in `node`'s text (trivia before and after each of its tokens). */
function comments(node, sf) {
  const text = sf.text;
  const seen = new Map();
  const visit = (n) => {
    for (const r of [...(ts.getLeadingCommentRanges(text, n.getFullStart()) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])])
      if (r.pos >= node.getFullStart() && r.end <= node.end) seen.set(r.pos, text.slice(r.pos, r.end));
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(node);
  return [...seen.values()];
}

const BOUNDS = ["toBeLessThan", "toBeLessThanOrEqual", "toBeGreaterThan"];
const COARSE_MIN_MS = 1000;

/** `expect(x)` (or expect.soft(x)) at the root of `call`'s matcher chain: its x, or null. */
function expected(call) {
  let e = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if ((ts.isIdentifier(c) && c.text === "expect") || (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "expect")) return e.arguments[0] ?? null;
      e = c;
    } else e = e.expression;
  }
  return null;
}

/**
 * Whether a test's `body` is a coarse guard: a "timing-check: coarse" comment (not text in a
 * string), and at least one bound on a measured value, each a literal of at least 1000 ms.
 */
function coarseGuard(body, sf, helpers, clocks) {
  if (!comments(body, sf).some((c) => c.includes(COARSE))) return false;
  // Variables the test sets from a measure: const ms = await paint(page).
  const measured = new Set();
  const findMeasured = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && measures(n.initializer, helpers, clocks)) measured.add(symbolOf(n.name, clocks));
    ts.forEachChild(n, findMeasured);
  };
  findMeasured(body);
  const usesMeasured = (n) => (ts.isIdentifier(n) && measured.has(symbolOf(n, clocks))) || !!ts.forEachChild(n, usesMeasured);
  let bounds = 0;
  let ok = true;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && BOUNDS.includes(n.expression.name.text)) {
      const x = expected(n);
      if (x && (measures(x, helpers, clocks) || usesMeasured(x))) {
        bounds++;
        const b = n.arguments[0] && skipParens(n.arguments[0]);
        if (!b || !ts.isNumericLiteral(b) || Number(b.text.replace(/_/g, "")) < COARSE_MIN_MS) ok = false;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return ok && bounds > 0;
}

/**
 * The tests of `source` that measure elapsed time without @timing: [{ line, title }].
 * Helpers are followed into files under `root` (the spec's folder by default); `read(path)`
 * gives an imported file's source, or null (the file system by default); `cache` keeps what
 * the files imported measure, for specs under the same root.
 */
export function untaggedTimingTests(source, fileName = "spec.ts", { root = dirname(resolve(fileName)), read = readSource, cache = new Map() } = {}) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { helpers, clocks } = analyse(sf, resolve(fileName), read, resolve(root), cache);

  const out = [];
  const walk = (n, tagged) => {
    const kind = testCallKind(n);
    if (kind) {
      const title = titleOf(n, sf);
      const isTagged = tagged || title.includes(TAG);
      const body = n.arguments[n.arguments.length - 1];
      if (kind === "test") {
        const coarse = body && coarseGuard(body, sf, helpers, clocks);
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
    ["coarse marker, tight budget", `test("parses", () => { const t0 = Date.now(); // ${COARSE}\n parse(big); expect(Date.now() - t0).toBeLessThan(50); });`, 1],
    ["coarse marker in a string, not a comment", `test("parses", () => { const t0 = Date.now(); parse("${COARSE}"); expect(Date.now() - t0).toBeLessThan(1500); });`, 1],
    ["coarse marker, budget through a helper", `async function paint() { const t0 = performance.now(); return 1; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 0],
    ["coarse marker, tight budget in a variable", `async function paint() { const t0 = performance.now(); return 1; }\ntest("draws", async () => { // ${COARSE}\n const ms = await paint(); expect(ms).toBeLessThanOrEqual(200); });`, 1],
    ["a clock name from another function", `function a() { const start = Date.now(); return start; }\ntest("offsets", () => { const start = 10; expect(start - 1).toBe(9); });`, 0],
    ["a clock name from another test", `test("a", () => { const start = Date.now(); expect(start).toBeGreaterThan(0); });\ntest("b", () => { const start = 10; expect(start - 1).toBe(9); });`, 0],
    ["new Date() in plain date maths", `test("dates", () => { const d = new Date(); const other = new Date(2026, 0, 1); expect(d - other).toBeGreaterThan(0); });`, 0],
    ["new Date() less another clock read", `test("parses", () => { const t0 = new Date(); parse(big); expect(new Date() - t0).toBeLessThan(1500); });`, 1],
    ["new Date() less Date.now()", `test("parses", () => { const t0 = Date.now(); parse(big); const d = new Date(); expect(d - t0).toBeLessThan(1500); });`, 1],
    ["a local clock wrapper", `test("parses", () => { const now = () => Date.now(); const a = now(); parse(big); expect(now() - a).toBeLessThan(1500); });`, 1],
    ["a clock wrapper with a block body", `function now() { return Date.now(); }\ntest("parses", () => { const a = now(); parse(big); const b = now(); expect(b - a).toBeLessThan(1500); });`, 1],
    ["-start + Date.now()", `test("parses", () => { const start = Date.now(); parse(big); expect(-start + Date.now()).toBeLessThan(1500); });`, 1],
    ["Math.abs(start - Date.now())", `test("parses", () => { const start = Date.now(); parse(big); expect(Math.abs(start - Date.now())).toBeLessThan(1500); });`, 1],
    ["coarse marker, no budget at all", `test("parses", () => { /* ${COARSE} */ const t0 = Date.now(); parse(big); expect(Date.now() - t0 < 50).toBe(true); });`, 1],
    // A coarse test with a 1500 ms decoy bound: every other use of a measured value is reported.
    ...[
      ["the measure as the bound", "expect(50).toBeGreaterThan(Date.now() - t0);"],
      ["the measure in a comparison", "expect(Date.now() - t0 < 50).toBe(true);"],
      ["the measure assigned later", "let ms = 0; ms = Date.now() - t0; expect(ms).toBeLessThan(50);"],
      ["a value derived from the measure", "const ms = Date.now() - t0; const s = ms / 1000; expect(s).toBeLessThan(0.05);"],
      ["the measure in a throw", 'const ms = Date.now() - t0; if (ms > 50) throw new Error("slow");'],
      ["the measure polled", "await expect.poll(() => Date.now() - t0).toBeLessThan(1500);"],
    ].map(([name, extra]) => [`coarse decoy, ${name}`, `test("parses", async () => { // ${COARSE}\n const t0 = Date.now(); parse(big); expect(Date.now() - t0).toBeLessThan(1500); ${extra} });`, 1]),
    ["coarse, the measure in a variable", `test("parses", () => { // ${COARSE}\n const t0 = Date.now(); parse(big); let ms = 0; ms = Date.now() - t0; expect(ms).toBeLessThan(1500); });`, 0],
    ["coarse, walk-brief's copy", `async function shownFor(page) { const t0 = performance.now(); return 1; }\ntest("5: shown for long", async ({ page }) => {\n // ${COARSE} (under load; the tight bound is the @timing test above)\n expect(await shownFor(page)).toBeLessThan(1500);\n });`, 0],
    // The clock against a deadline (a clock read plus or minus a budget).
    ["the clock bounded by a deadline", `test("parses", () => { const deadline = Date.now() + 50; parse(big); expect(Date.now()).toBeLessThan(deadline); });`, 1],
    ["the clock polled against a deadline", `test("parses", async () => { const deadline = Date.now() + 50; await expect.poll(() => Date.now()).toBeLessThan(deadline); });`, 1],
    ["a deadline bounded by the clock", `test("parses", () => { const t0 = Date.now(); parse(big); expect(t0 + 50).toBeGreaterThan(Date.now()); });`, 1],
    ["the clock past a deadline throws", `test("parses", () => { const deadline = Date.now() + 50; parse(big); if (Date.now() > deadline) throw new Error("slow"); });`, 1],
    ["the clock and a deadline in an expect", `test("parses", () => { const deadline = Date.now() + 50; parse(big); expect(Date.now() < deadline).toBe(true); });`, 1],
    ["a deadline that only stops a loop", `test("waits", async () => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await done()) break; await sleep(100); } expect(await done()).toBe(true); });`, 0],
    ["a deadline that breaks a loop", `test("waits", async () => { const deadline = Date.now() + 5000; for (;;) { if (await done() || Date.now() > deadline) break; await sleep(100); } expect(await done()).toBe(true); });`, 0],
    // More clocks.
    ["process.hrtime.bigint()", `test("parses", () => { const t0 = process.hrtime.bigint(); parse(big); expect(Number(process.hrtime.bigint() - t0)).toBeLessThan(1.5e9); });`, 1],
    ["process.hrtime(t0)", `test("parses", () => { const t0 = process.hrtime(); parse(big); const [s] = process.hrtime(t0); expect(s).toBeLessThan(2); });`, 1],
    ["an aliased clock", `test("parses", () => { const clock = Date.now; const t0 = clock(); parse(big); expect(clock() - t0).toBeLessThan(1500); });`, 1],
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
    // An import cycle: viaA measures only through a.ts, which measures only through b.ts.
    "/e2e/a.ts": `import { slow } from "./b"; export function timed() { return slow(); }`,
    "/e2e/b.ts": `import { timed } from "./a"; export function slow() { const t0 = Date.now(); return Date.now() - t0; } export function viaA() { return timed(); }`,
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
  // Specs sharing one cache: what a.spec.ts read of the cycle must not cut short what b's importer sees.
  const shared = new Map();
  for (const [name, src, want] of [
    ["a cycle, entered from a.ts", spec(`import { timed } from "./a";`, "timed()"), 1],
    ["a cycle, then b.ts from the cache", spec(`import { viaA } from "./b";`, "viaA()"), 1],
  ]) {
    const got = untaggedTimingTests(src, "/e2e/a.spec.ts", { root: "/e2e", read, cache: shared }).length;
    if (got !== want) failed.push([name, want, got]);
  }
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
  const cache = new Map();
  const bad = specs(join(web, "e2e")).flatMap((f) => untaggedTimingTests(readFileSync(f, "utf8"), f, { root: join(web, "e2e"), cache }).map((t) => `${relative(web, f)}:${t.line} ${t.title}`));
  if (bad.length) {
    console.error(`These tests measure elapsed time; add ${TAG} to their titles so they run alone in e2e-timing:\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("check-timing-tags: every timing test is tagged @timing");
}
