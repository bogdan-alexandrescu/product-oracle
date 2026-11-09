#!/usr/bin/env node
// Fails when a mock spec measures elapsed time in a test whose title (or describe) lacks
// @timing. Timing specs run alone in CI's e2e-timing job; untagged, they run in the
// parallel mock-e2e shards and flake under load (playwright.config.ts: grepInvert).
//
// A test measures elapsed time when its body, or a helper function it calls (of the file, or
// imported from another file under e2e/; the mock API it drives is not the test), subtracts
// from the clock, reads performance.now() or process.hrtime(t0), or checks the clock against a
// deadline (a clock read plus or minus a budget, or a call of a function that returns one:
// expect(Date.now()).toBeLessThan(until), if (Date.now() > by(50)) throw ...). A deadline check
// that only stops a poll (a loop's condition, or an if that neither throws, calls expect() nor
// sets a variable that is then asserted, as in if (Date.now() > d) late = true; expect(late)
// .toBe(false)) waits; it does not measure.
// The clock is Date.now(), performance.now(), process.hrtime() / .bigint(), new Date().getTime()
// / .valueOf(), +new Date(), however spelt (Date["now"](), globalThis.Date.now(), D.now() with
// const D = Date, now() with const { now } = Date), a variable set from one of them in its own
// scope ("end - start" with const end = Date.now()), a call of a function that returns one
// (const now = () => Date.now()) or of one under another name (const clock = Date.now); new
// Date() counts only when another clock read is taken from it ("new Date() - t0"), never in
// plain date maths.
// A coarse guard meant for the parallel shards says so with a "timing-check: coarse" comment
// in the test; it passes only when every use of a measured value in it is set whole into a
// variable or is the subject of a bound (expect(ms).toBeLessThan, toBeLessThanOrEqual,
// toBeGreaterThan) that is a literal of at least 1000 ms, with at least one such bound, and
// each bound's subject is an elapsed time in ms as measured (Date.now() - t0, or a helper that
// returns one unscaled), never one scaled ((performance.now() - t0) * 100), in ns, or a timestamp.
//
//   node scripts/check-timing-tags.mjs              self-test, then every e2e spec (not e2e/real)
//   node scripts/check-timing-tags.mjs --self-test  the self-test only
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TAG = "@timing";
const COARSE = "timing-check: coarse";

const CLOCK_OBJECTS = ["Date", "performance", "process"];
const GLOBALS = ["globalThis", "window", "self", "global"];

/** The member `a.b` or `a["b"]` names: b, or null. */
function memberName(n) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

/** The clock object `n` is ("Date", "performance" or "process"), also as globalThis.Date and the like or a variable set to one (const D = Date); or null. */
function clockObject(n, clocks) {
  n = skipParens(n);
  if (ts.isIdentifier(n)) return CLOCK_OBJECTS.includes(n.text) ? n.text : (clocks?.objects.get(symbolOf(n, clocks)) ?? null);
  const name = memberName(n);
  const of = name && skipParens(n.expression);
  return CLOCK_OBJECTS.includes(name) && ts.isIdentifier(of) && GLOBALS.includes(of.text) ? name : null;
}

/** `performance.now()`, however spelt (window.performance["now"]()). */
function isPerformanceNow(n, clocks) {
  return ts.isCallExpression(n) && isClockRef(n.expression, clocks) && clockObject(skipParens(n.expression).expression, clocks) === "performance";
}

/** `Date.now`, `performance.now`, `process.hrtime` or `process.hrtime.bigint`, uncalled, however spelt (Date["now"], globalThis.Date.now, D.now with const D = Date). */
function isClockRef(n, clocks) {
  n = skipParens(n);
  const name = memberName(n);
  if (!name) return false;
  const of = clockObject(n.expression, clocks);
  if (of) return (name === "now" && of !== "process") || (name === "hrtime" && of === "process");
  const inner = skipParens(n.expression);
  return name === "bigint" && memberName(inner) === "hrtime" && clockObject(inner.expression, clocks) === "process";
}

/** `process.hrtime(t0)`: the time since t0, a measure in itself. */
function isHrtimeSince(n, clocks) {
  return ts.isCallExpression(n) && n.arguments.length > 0 && isClockRef(n.expression, clocks) && memberName(skipParens(n.expression)) === "hrtime";
}

/** `process.hrtime()` or `process.hrtime.bigint()` (or an item of one): a read in ns or [s, ns], not ms. */
function isHrtimeRead(n, clocks) {
  n = skipParens(n);
  if (ts.isElementAccessExpression(n)) return isHrtimeRead(n.expression, clocks);
  return ts.isCallExpression(n) && isClockRef(n.expression, clocks) && ["hrtime", "bigint"].includes(memberName(skipParens(n.expression)));
}

/** `new Date()`, no arguments (also new D() with const D = Date). */
function isNewDate(n, clocks) {
  return ts.isNewExpression(n) && clockObject(n.expression, clocks) === "Date" && !n.arguments?.length;
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
  if (ts.isCallExpression(n) && isClockRef(n.expression, clocks)) return isHrtimeSince(n, clocks) ? 0 : STRONG;
  if (isNewDate(n, clocks)) return WEAK;
  if (ts.isElementAccessExpression(n)) return clockKind(n.expression, clocks); // process.hrtime()[0]
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.PlusToken)
    return isNewDate(skipParens(n.operand), clocks) ? STRONG : clockKind(n.operand, clocks);
  if (ts.isCallExpression(n) && !n.arguments.length && ts.isPropertyAccessExpression(n.expression) && ["getTime", "valueOf"].includes(n.expression.name.text)) {
    const of = skipParens(n.expression.expression);
    return isNewDate(of, clocks) ? STRONG : clockKind(of, clocks);
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

/** What a function with this `body` returns: its expression body, or its return statements' values. */
function returned(body) {
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out = [];
  const visit = (n) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** The clock reads `fn` returns (the surest of them), or 0. */
function returnKind(fn, clocks) {
  return Math.max(0, ...returned(fn.body).map((x) => clockKind(x, clocks)));
}

/**
 * `sf`'s clock variables (const end = Date.now(); t0 = performance.now()), clock functions
 * (const now = () => Date.now(); const clock = Date.now; const { now } = Date), clock objects
 * (const D = Date), deadlines (const until = Date.now() + 3000) and functions that return one
 * (const by = (ms) => Date.now() + ms), each by its declaration, so a name in another scope is
 * not one.
 */
function findClocks(sf) {
  const clocks = { sf, checker: checkerFor(sf), vars: new Map(), fns: new Map(), deadlines: new Map(), deadlineFns: new Map(), objects: new Map() };
  let grew = true;
  const raise = (map, id, kind) => {
    const s = kind && symbolOf(id, clocks);
    if (s && kind > (map.get(s) ?? 0)) {
      map.set(s, kind);
      grew = true;
    }
  };
  const returnsDeadline = (fn) => (returned(fn.body).some((x) => isDeadline(x, clocks)) ? STRONG : 0);
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = skipParens(n.initializer);
      const object = clockObject(init, clocks);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        raise(clocks.fns, n.name, returnKind(init, clocks));
        raise(clocks.deadlineFns, n.name, returnsDeadline(init));
      } else if (isClockAlias(init, clocks)) raise(clocks.fns, n.name, STRONG);
      else if (object) {
        const s = symbolOf(n.name, clocks);
        if (s && !clocks.objects.has(s)) {
          clocks.objects.set(s, object);
          grew = true;
        }
      } else {
        raise(clocks.vars, n.name, clockKind(init, clocks));
        raise(clocks.deadlines, n.name, isDeadline(init, clocks) ? STRONG : 0);
      }
    } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ["Date", "performance"].includes(clockObject(n.initializer, clocks))) {
      // const { now } = Date; const { now: clock } = performance
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(el.name) && (ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === "now") raise(clocks.fns, el.name, STRONG);
      }
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      raise(clocks.fns, n.name, returnKind(n, clocks));
      raise(clocks.deadlineFns, n.name, returnsDeadline(n));
    }
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
function isClockAlias(n, clocks) {
  n = skipParens(n);
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "bind") n = n.expression.expression;
  return isClockRef(n, clocks);
}

/** A deadline: a timestamp plus or minus a budget (Date.now() + 3000, t0 - 50), a variable set to one, or a call of a function that returns one (by(50)). */
function isDeadline(node, clocks) {
  const n = skipParens(node);
  if (ts.isIdentifier(n)) return clocks.deadlines.has(symbolOf(n, clocks));
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) return clocks.deadlineFns.has(symbolOf(n.expression, clocks));
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

/** Whether the identifier `id` is asserted where it is read: in an expect(), a throw, or the condition of an if (or ?:) that asserts. */
function assertedAt(id) {
  for (let c = id, p = id.parent; p && !ts.isFunctionLike(p); [c, p] = [p, p.parent]) {
    if (ts.isThrowStatement(p) || (ts.isCallExpression(p) && expected(p) !== null)) return true;
    if (ts.isIfStatement(p) && p.expression === c) return asserts(p.thenStatement) || asserts(p.elseStatement);
    if (ts.isConditionalExpression(p) && p.condition === c) return asserts(p.whenTrue) || asserts(p.whenFalse);
    if (ts.isStatement(p)) return false;
  }
  return false;
}

/** The variables of `clocks`' file that are asserted somewhere (assertedAt), by declaration. */
function assertedVars(clocks) {
  if (!clocks.asserted) {
    clocks.asserted = new Set();
    const visit = (n) => {
      if (ts.isIdentifier(n) && assertedAt(n)) clocks.asserted.add(symbolOf(n, clocks));
      ts.forEachChild(n, visit);
    };
    visit(clocks.sf);
  }
  return clocks.asserted;
}

const INCREMENTS = [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken];

/** Whether `n` sets a variable that is then asserted (if (Date.now() > d) late = true; expect(late).toBe(false)). */
function setsAsserted(n, clocks) {
  if (!n) return false;
  let target = null;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = skipParens(n.left);
  else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && INCREMENTS.includes(n.operator)) target = skipParens(n.operand);
  else if (ts.isVariableDeclaration(n) && n.initializer) target = n.name;
  if (target && ts.isIdentifier(target) && assertedVars(clocks).has(symbolOf(target, clocks))) return true;
  return !!ts.forEachChild(n, (c) => setsAsserted(c, clocks));
}

/** Whether the value of `n` is set into a variable that is then asserted (const late = Date.now() > d ? 1 : 0). */
function setIntoAsserted(n, clocks) {
  const v = valueOf(n);
  const p = v.parent;
  const target = ts.isVariableDeclaration(p) && p.initializer === v ? p.name : ts.isBinaryExpression(p) && p.right === v && p.operatorToken.kind === ts.SyntaxKind.EqualsToken ? skipParens(p.left) : null;
  return !!target && ts.isIdentifier(target) && assertedVars(clocks).has(symbolOf(target, clocks));
}

/**
 * Whether a comparison of the clock with a deadline only waits: it is the condition of a loop,
 * or of an if (or ?:) none of whose branches throws, calls expect() or sets a variable that is
 * then asserted (a flag: if (Date.now() > d) late = true; expect(late).toBe(false)), and a ?:
 * whose value is not set into one, so it stops a poll rather than failing the test on the time.
 */
function onlyWaits(cmp, clocks) {
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
  const quiet = (...branches) => branches.every((b) => !asserts(b) && !setsAsserted(b, clocks));
  if (ts.isIfStatement(p) && p.expression === c) return quiet(p.thenStatement, p.elseStatement);
  if (ts.isConditionalExpression(p) && p.condition === c) return quiet(p.whenTrue, p.whenFalse) && !setIntoAsserted(p, clocks);
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
      if ((vs(n.left, n.right) || vs(n.right, n.left)) && !onlyWaits(n, clocks)) return true;
    }
    return false;
  }
  if (!ts.isCallExpression(n)) return false;
  if (isPerformanceNow(n, clocks) || isHrtimeSince(n, clocks) || helpers.has(calleeName(n))) return true;
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

/** The values set into the variable `id` names: its initializer and every assignment to it (`ms *= 100` as such). */
function valuesSet(id, clocks) {
  const s = symbolOf(id, clocks);
  if (!s) return [];
  if (!clocks.sets) {
    clocks.sets = new Map();
    const add = (target, value) => {
      const t = ts.isIdentifier(target) && symbolOf(target, clocks);
      if (t) clocks.sets.set(t, [...(clocks.sets.get(t) ?? []), value]);
    };
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) add(n.name, n.initializer);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) add(skipParens(n.left), n.right);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind > ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) add(skipParens(n.left), n);
      ts.forEachChild(n, visit);
    };
    visit(clocks.sf);
  }
  return clocks.sets.get(s) ?? [];
}

const SCALES = [ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken];
const ROUNDS = ["Math.round", "Math.floor", "Math.ceil", "Math.trunc", "Math.abs"];

/** `n` past parentheses, await, `as`, `satisfies` and `!`. */
function inner(n) {
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression;
    else return n;
  }
}

/** Whether `n` is a reading in ms, not scaled: not maths with * / % ** or shifts, not an hrtime read (ns), nor a variable set to one. */
function unscaledReading(node, clocks, seen = new Set()) {
  const n = inner(node);
  if (isHrtimeRead(n, clocks)) return false;
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (SCALES.includes(op) || (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment && op !== ts.SyntaxKind.EqualsToken && op !== ts.SyntaxKind.PlusEqualsToken && op !== ts.SyntaxKind.MinusEqualsToken)) return false;
    return unscaledReading(n.left, clocks, seen) && unscaledReading(n.right, clocks, seen);
  }
  if (ts.isPrefixUnaryExpression(n)) return unscaledReading(n.operand, clocks, seen);
  if (ts.isIdentifier(n)) {
    const s = symbolOf(n, clocks);
    if (!s || seen.has(s)) return true;
    seen.add(s);
    return valuesSet(n, clocks).every((v) => unscaledReading(v, clocks, seen));
  }
  return true;
}

/**
 * Whether `node` is an elapsed time in ms as measured, not scaled: a difference of unscaled
 * readings (Date.now() - t0, seen[seen.length - 1] - seen[0]) or -t0 + Date.now(); a ?: of
 * such and 0; a whole rounding of one (Math.round); a variable set only to one (or 0); or a call of a
 * function `raw` names, one that returns one. Not a timestamp, nor a measure in ns or scaled.
 */
function unscaledElapsed(node, clocks, raw, seen = new Set()) {
  const n = inner(node);
  const reading = (x) => unscaledReading(x, clocks);
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    const negated = (x) => ((x = skipParens(x)), ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && reading(x.operand));
    if (op === ts.SyntaxKind.MinusToken) return reading(n.left) && reading(n.right);
    if (op === ts.SyntaxKind.PlusToken) return (negated(n.left) && reading(n.right)) || (negated(n.right) && reading(n.left));
    return false;
  }
  // Each of these, or 0 (a placeholder), and not all 0.
  const elapsedOrZero = (values) => values.every((x) => isZero(x) || unscaledElapsed(x, clocks, raw, seen)) && !values.every(isZero);
  if (ts.isConditionalExpression(n)) return elapsedOrZero([n.whenTrue, n.whenFalse]);
  if (ts.isCallExpression(n)) {
    const name = calleeName(n);
    if (ROUNDS.includes(name)) return n.arguments.length === 1 && unscaledElapsed(n.arguments[0], clocks, raw, seen);
    return raw.has(name);
  }
  if (ts.isIdentifier(n)) {
    const s = symbolOf(n, clocks);
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return elapsedOrZero(valuesSet(n, clocks));
  }
  return false;
}

function isZero(n) {
  n = inner(n);
  return ts.isNumericLiteral(n) && Number(n.text) === 0;
}

/** Whether a function with this `body` returns an unscaled elapsed time in ms, and nothing else (unscaledElapsed). */
function returnsUnscaled(body, clocks, raw) {
  const values = returned(body);
  return values.length > 0 && values.every((v) => unscaledElapsed(v, clocks, raw));
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
 * One file's view of what measures: its named functions that do and the imported ones it may
 * call (`helpers`, by local name), those of them that return an unscaled elapsed time in ms
 * (`raw`), and those it exports (`exports`: exported name -> whether it is raw).
 */
function analyse(sf, fileName, read, root, cache) {
  // Imported functions that measure, under their local names.
  const helpers = new Set();
  const raw = new Set();
  const addHelper = (local, isRaw) => {
    helpers.add(local);
    if (isRaw) raw.add(local);
  };
  const exportedFrom = (spec) => {
    const p = resolveImport(spec, fileName, read, root);
    return p ? measuringExports(p, read, root, cache) : new Map();
  };
  const reexports = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause && !st.importClause.isTypeOnly) {
      const exp = exportedFrom(st.moduleSpecifier.text);
      if (!exp.size) continue;
      const c = st.importClause;
      if (c.name && exp.has("default")) addHelper(c.name.text, exp.get("default"));
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) for (const [e, isRaw] of exp) addHelper(`${b.name.text}.${e}`, isRaw);
      else if (b) for (const el of b.elements) if (exp.has((el.propertyName ?? el.name).text)) addHelper(el.name.text, exp.get((el.propertyName ?? el.name).text));
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      const exp = exportedFrom(st.moduleSpecifier.text);
      if (!st.exportClause) {
        for (const [e, isRaw] of exp) if (e !== "default") reexports.set(e, isRaw);
      } else if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) if (exp.has((el.propertyName ?? el.name).text)) reexports.set(el.name.text, exp.get((el.propertyName ?? el.name).text));
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
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of fns) {
      if (raw.has(name) || !helpers.has(name) || !returnsUnscaled(body, clocks, raw)) continue;
      raw.add(name);
      grew = true;
    }
  }
  const exports = new Map(reexports);
  for (const [name, local] of exported) if (helpers.has(local)) exports.set(name, raw.has(local));
  return { helpers, raw, clocks, exports };
}

/** How much of `exports` (an analyse() result's) is known: its names, and its raw ones. */
function grown(exports) {
  return exports.size + [...exports.values()].filter(Boolean).length;
}

// Per cache, the files being read (a stack), what each exports so far, the lowest file on the
// stack each reaches through a cycle, and whether a later file came back to it.
const walks = new WeakMap();

/**
 * The exported names of the file at `path` that measure, each with whether it returns an
 * unscaled elapsed time in ms (analyse's `exports`). A file in an import cycle is read
 * again until what it exports stops growing; one that reaches back to a file still being read
 * below it is not cached, since what it saw of that file was partial.
 */
function measuringExports(path, read, root, cache) {
  if (cache.has(path)) return cache.get(path);
  if (!walks.has(cache)) walks.set(cache, { stack: [], partial: new Map(), low: [], back: [] });
  const walk = walks.get(cache);
  const at = walk.stack.indexOf(path);
  if (at >= 0) {
    const top = walk.stack.length - 1;
    walk.low[top] = Math.min(walk.low[top], at);
    walk.back[at] = true;
    return walk.partial.get(path) ?? new Map();
  }
  const source = read(path);
  if (source === null) {
    cache.set(path, new Map());
    return cache.get(path);
  }
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const me = walk.stack.push(path) - 1;
  walk.low[me] = me;
  let exports = new Map();
  for (;;) {
    walk.back[me] = false;
    const before = grown(exports);
    ({ exports } = analyse(sf, path, read, root, cache));
    walk.partial.set(path, exports);
    if (!walk.back[me] || grown(exports) === before) break;
  }
  walk.stack.pop();
  walk.partial.delete(path);
  const low = walk.low.pop();
  walk.back.pop();
  if (me > 0) walk.low[me - 1] = Math.min(walk.low[me - 1], low);
  if (low >= me) cache.set(path, exports);
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
      if (isExpect(c)) return e.arguments[0] ?? null;
      e = c;
    } else e = e.expression;
  }
  return null;
}

/** `expect(...)` or `expect.soft(...)` and the like: whether `callee` is expect's. */
function isExpect(callee) {
  return (ts.isIdentifier(callee) && callee.text === "expect") || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect");
}

/** The node whose value is `n`'s: `n` past parentheses, await, `as`, `satisfies` and `!`. */
function valueOf(n) {
  const passes = (p) => ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p) || ts.isTypeAssertionExpression(p);
  while (n.parent && passes(n.parent)) n = n.parent;
  return n;
}

/**
 * Whether a test's `body` is a coarse guard: a "timing-check: coarse" comment (not text in a
 * string), and every use of a measured value in it is one of: set whole into a variable
 * (const ms = Date.now() - t0; ms = await paint(page)), which is then measured too; or the
 * subject of a bound that is a literal of at least 1000 ms (expect(ms).toBeLessThan(1500)),
 * the subject an elapsed time in ms as measured (unscaledElapsed: Date.now() - t0, or a helper
 * that returns one; not one scaled, in ns, or a timestamp). At least one such bound. Anything
 * else (maths on it, a comparison, a throw, a poll, a bound it is the argument of, a deadline
 * check) makes the test not coarse.
 */
function coarseGuard(body, sf, helpers, raw, clocks) {
  if (!comments(body, sf).some((c) => c.includes(COARSE))) return false;
  const measured = new Set(); // variables set from a measure: const ms = await paint(page)
  const isMeasured = (n) => ts.isIdentifier(n) && measured.has(symbolOf(n, clocks));
  const isTarget = (n) => (ts.isVariableDeclaration(n.parent) && n.parent.name === n) || (ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  // Where a measured value goes: the variable it is set into, "bound", or null for anything else.
  const goesTo = (n) => {
    const v = valueOf(n);
    const p = v.parent;
    if (ts.isVariableDeclaration(p) && p.initializer === v && ts.isIdentifier(p.name)) return p.name;
    if (ts.isBinaryExpression(p) && p.right === v && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) return p.left;
    if (ts.isCallExpression(p) && p.arguments[0] === v && isExpect(p.expression)) {
      const m = p.parent;
      if (ts.isPropertyAccessExpression(m) && m.expression === p && BOUNDS.includes(m.name.text) && ts.isCallExpression(m.parent) && m.parent.expression === m) {
        const b = m.parent.arguments[0] && skipParens(m.parent.arguments[0]);
        if (b && ts.isNumericLiteral(b) && Number(b.text.replace(/_/g, "")) >= COARSE_MIN_MS && unscaledElapsed(n, clocks, raw)) return "bound";
      }
    }
    return null;
  };
  let bounds, ok, grew;
  const visit = (n) => {
    if (!isTarget(n) && (measureAt(n, helpers, clocks) || isMeasured(n))) {
      const u = goesTo(n);
      if (u === "bound") bounds++;
      else if (!u) ok = false;
      else if (symbolOf(u, clocks) && !isMeasured(u)) {
        measured.add(symbolOf(u, clocks));
        grew = true;
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  do {
    [bounds, ok, grew] = [0, true, false];
    visit(body);
  } while (grew);
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
  const { helpers, raw, clocks } = analyse(sf, resolve(fileName), read, resolve(root), cache);

  const out = [];
  const walk = (n, tagged) => {
    const kind = testCallKind(n);
    if (kind) {
      const title = titleOf(n, sf);
      const isTagged = tagged || title.includes(TAG);
      const body = n.arguments[n.arguments.length - 1];
      if (kind === "test") {
        const coarse = body && coarseGuard(body, sf, helpers, raw, clocks);
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
    ["coarse marker, budget through a helper", `async function paint() { const t0 = performance.now(); await draw(); return performance.now() - t0; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 0],
    ["coarse marker, tight budget in a variable", `async function paint() { const t0 = performance.now(); await draw(); return performance.now() - t0; }\ntest("draws", async () => { // ${COARSE}\n const ms = await paint(); expect(ms).toBeLessThanOrEqual(200); });`, 1],
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
    ["coarse, walk-brief's copy", `async function shownFor(page) { const seen = await page.evaluate(() => [performance.now()]); return seen.length ? seen[seen.length - 1] - seen[0] : 0; }\ntest("5: shown for long", async ({ page }) => {\n // ${COARSE} (under load; the tight bound is the @timing test above)\n expect(await shownFor(page)).toBeLessThan(1500);\n });`, 0],
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
    // Other spellings of a clock read.
    ...[
      ["const { now } = Date", "const { now } = Date;", "now()"],
      ["const { now: clock } = performance", "const { now: clock } = performance;", "clock()"],
      ["Date['now']()", "", 'Date["now"]()'],
      ["globalThis.Date.now()", "", "globalThis.Date.now()"],
      ["window.performance.now()", "", "window.performance.now()"],
      ["const D = Date; D.now()", "const D = Date;", "D.now()"],
      ["const D = globalThis.Date; new D().getTime()", "const D = globalThis.Date;", "new D().getTime()"],
    ].map(([name, pre, read]) => [`the clock as ${name}`, `test("parses", () => { ${pre} const t0 = ${read}; parse(big); expect(${read} - t0).toBeLessThan(1500); });`, 1]),
    ["a Date alias in plain date maths", `test("dates", () => { const D = Date; const a = new D(2026, 0, 1); expect(new D(2026, 0, 2) - a).toBe(864e5); });`, 0],
    // Deadlines made by a helper.
    ["a deadline from a helper", `test("parses", () => { const by = (ms) => Date.now() + ms; parse(big); expect(Date.now()).toBeLessThan(by(50)); });`, 1],
    ["a deadline from a helper, in a variable", `function after(ms) { return Date.now() + ms; }\ntest("parses", () => { const until = after(50); parse(big); if (Date.now() > until) throw new Error("slow"); });`, 1],
    ["a deadline from a helper that only stops a loop", `const by = (ms) => Date.now() + ms;\ntest("waits", async () => { const until = by(5000); while (Date.now() < until) { if (await done()) break; await sleep(100); } expect(await done()).toBe(true); });`, 0],
    // A flag set when the clock passes a deadline, then asserted.
    ["a flag set past a deadline, then asserted", `test("parses", () => { const d = Date.now() + 50; let late = false; parse(big); if (Date.now() > d) late = true; expect(late).toBe(false); });`, 1],
    ["a flag set in time, then asserted", `test("parses", () => { const d = Date.now() + 50; let ok = false; parse(big); if (Date.now() < d) { ok = true; } else { ok = false; } expect(ok).toBeTruthy(); });`, 1],
    ["a flag set by ?:, then asserted", `test("parses", () => { const d = Date.now() + 50; parse(big); const late = Date.now() > d ? 1 : 0; expect(late).toBe(0); });`, 1],
    ["a flag set past a deadline, then thrown on", `test("parses", () => { const d = Date.now() + 50; let late = false; parse(big); if (Date.now() > d) late = true; if (late) throw new Error("slow"); });`, 1],
    ["a flag that only stops a poll", `test("waits", async () => { const d = Date.now() + 5000; let gaveUp = false; while (!gaveUp) { if (await done()) break; if (Date.now() > d) gaveUp = true; await sleep(100); } expect(await done()).toBe(true); });`, 0],
    // A coarse bound counts only on an elapsed value in ms, as measured.
    ["coarse, a helper that scales its measure", `async function paint() { const t0 = performance.now(); await draw(); return (performance.now() - t0) * 100; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["coarse, a scaled helper's measure in a variable", `async function paint() { const t0 = performance.now(); await draw(); const ms = performance.now() - t0; return ms / 0.01; }\ntest("draws", async () => { // ${COARSE}\n const ms = await paint(); expect(ms).toBeLessThan(1500); });`, 1],
    ["coarse, a helper that returns no measure", `async function paint() { const t0 = performance.now(); await draw(); return 1; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["coarse, a helper that returns a timestamp", `async function paint() { await draw(); return performance.now(); }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["coarse, a timestamp bounded", `test("draws", async () => { // ${COARSE}\n await draw(); expect(performance.now()).toBeLessThan(1500); });`, 1],
    ["coarse, nanoseconds bounded", `test("draws", async () => { // ${COARSE}\n const t0 = process.hrtime.bigint(); await draw(); const ns = process.hrtime.bigint() - t0; expect(ns).toBeLessThan(1500); });`, 1],
    ["coarse, a helper's measure through another helper", `async function paint() { const t0 = Date.now(); await draw(); const ms = Date.now() - t0; return ms; }\nasync function twice() { return Math.round(await paint()); }\ntest("draws", async () => { // ${COARSE}\n expect(await twice()).toBeLessThan(1500); });`, 0],
    // A deadline from an async helper, awaited.
    ["await on a deadline helper", `async function by(ms) { return Date.now() + ms; }\ntest("parses", async () => { parse(big); if (Date.now() > await by(50)) throw new Error("slow"); });`, 1],
    ["await on a deadline helper, in a variable", `async function after(ms) { return Date.now() + ms; }\ntest("parses", async () => { const until = await after(50); parse(big); expect(Date.now()).toBeLessThan(until); });`, 1],
    // A flag set through a property or pushed into an array, then asserted.
    ["a flag set through a property", `test("parses", () => { const t = Date.now() + 50; const state = { late: false }; parse(big); state.late = Date.now() > t; expect(state.late).toBe(false); });`, 1],
    ["a flag set through a property past a deadline", `test("parses", () => { const t = Date.now() + 50; const state = { late: false }; parse(big); if (Date.now() > t) state.late = true; expect(state.late).toBe(false); });`, 1],
    ["a flag set through a property by ?:", `test("parses", () => { const t = Date.now() + 50; const state = { late: 0 }; parse(big); state.late = Date.now() > t ? 1 : 0; expect(state.late).toBe(0); });`, 1],
    ["a flag pushed into an array past a deadline", `test("parses", () => { const t = Date.now() + 50; const late = []; parse(big); if (Date.now() > t) late.push("parse"); expect(late).toEqual([]); });`, 1],
    ["a flag pushed into an array by ?:", `test("parses", () => { const t = Date.now() + 50; const late = []; parse(big); late.push(Date.now() > t ? 1 : 0); expect(late).toEqual([0]); });`, 1],
    ["a property flag that only stops a poll", `test("waits", async () => { const d = Date.now() + 5000; const state = { gaveUp: false }; while (!state.gaveUp) { if (await done()) break; if (Date.now() > d) state.gaveUp = true; await sleep(100); } expect(await done()).toBe(true); });`, 0],
    ["a pushed flag never asserted", `test("waits", async () => { const d = Date.now() + 5000; const log = []; for (;;) { if (await done()) break; if (Date.now() > d) { log.push("gave up"); break; } await sleep(100); } expect(await done()).toBe(true); });`, 0],
    // A hidden offset inside a subtraction is no elapsed time as measured.
    ["an offset inside the subtraction", `test("parses", () => { const start = Date.now(); parse(big); expect((Date.now() + 0) - start).toBeLessThan(1500); });`, 1],
    ["coarse, an offset inside the subtraction", `test("parses", () => { // ${COARSE}\n const start = Date.now(); parse(big); expect((Date.now() + 0) - start).toBeLessThan(1500); });`, 1],
    ["coarse, a helper with an offset inside its subtraction", `async function paint() { const t0 = performance.now(); await draw(); return (performance.now() + 1400) - t0; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["coarse, a helper with an offset on its start", `async function paint() { const t0 = performance.now(); await draw(); return performance.now() - (t0 - 1400); }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["coarse, a helper whose start is moved", `async function paint() { let t0 = performance.now(); t0 -= 1400; await draw(); return performance.now() - t0; }\ntest("draws", async () => { // ${COARSE}\n expect(await paint()).toBeLessThan(1500); });`, 1],
    ["a deadline less the clock, inline", `test("waits", async () => { const opened = Date.now(); await wait((opened + 3000) - Date.now()); });`, 0],
    // Still more spellings of the clock.
    ["const { hrtime } = process", `test("parses", () => { const { hrtime } = process; const t0 = hrtime(); parse(big); const [s] = hrtime(t0); expect(s).toBeLessThan(2); });`, 1],
    ["const { bigint } = process.hrtime", `test("parses", () => { const { bigint } = process.hrtime; const t0 = bigint(); parse(big); expect(Number(bigint() - t0)).toBeLessThan(1.5e9); });`, 1],
    ["a Date alias declared after its use", `test("parses", () => { const t0 = D.now(); parse(big); expect(D.now() - t0).toBeLessThan(1500); });\nconst D = Date;`, 1],
    ["a Date alias set after its use", `let D;\ntest("parses", () => { const t0 = D.now(); parse(big); expect(D.now() - t0).toBeLessThan(1500); });\nD = Date;`, 1],
    ["Date.now.call(null)", `test("parses", () => { const t0 = Date.now.call(null); parse(big); expect(Date.now.call(null) - t0).toBeLessThan(1500); });`, 1],
    ["process.hrtime.call(process, t0)", `test("parses", () => { const t0 = process.hrtime(); parse(big); const [s] = process.hrtime.call(process, t0); expect(s).toBeLessThan(2); });`, 1],
  ];
  // Imported helpers: a spec at /e2e/a.spec.ts and the files it imports.
  const files = {
    "/e2e/clock.ts": `export async function paint(page) { const t0 = Date.now(); await page.goto("/"); return Date.now() - t0; }
      export const timed = async (fn) => { const t0 = new Date().getTime(); await fn(); return new Date().getTime() - t0; };
      function stamp() { const end = Date.now(); return end - started; }
      export { stamp as lap };
      export function open(page) { return page.goto("/"); }
      export async function scaled(page) { const t0 = Date.now(); await page.goto("/"); return (Date.now() - t0) * 100; }`,
    "/e2e/again.ts": `export { paint, scaled } from "./clock";`,
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
    ["coarse, an imported helper", spec(`import { paint } from "./clock";`, "paint(page)").replace("expect(", `// ${COARSE}\n expect(`).replace("2000", "1500"), 0],
    ["coarse, an imported helper that scales", spec(`import { scaled } from "./clock";`, "scaled(page)").replace("expect(", `// ${COARSE}\n expect(`).replace("2000", "1500"), 1],
    ["coarse, an imported, re-exported helper that scales", spec(`import { scaled as s } from "./again";`, "s(page)").replace("expect(", `// ${COARSE}\n expect(`).replace("2000", "1500"), 1],
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
