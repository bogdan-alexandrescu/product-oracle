#!/usr/bin/env node
// Fails when a mock spec measures elapsed time in a test whose title (or describe) lacks
// @timing. Timing specs run alone in CI's e2e-timing job; untagged, they run in the
// parallel mock-e2e shards and flake under load (playwright.config.ts: grepInvert).
//
// A test measures elapsed time when its body, or a helper function of the file it calls,
// subtracts from Date.now() / performance.now() ("now() - start") or reads performance.now().
//
//   node scripts/check-timing-tags.mjs              self-test, then every e2e spec (not e2e/real)
//   node scripts/check-timing-tags.mjs --self-test  the self-test only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TAG = "@timing";

function isNowCall(node, objects = ["Date", "performance"]) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "now" &&
    ts.isIdentifier(node.expression.expression) &&
    objects.includes(node.expression.expression.text)
  );
}

/** Whether `node` measures time itself; `helpers` names the file's functions that do. */
function measures(node, helpers) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.MinusToken && isNowCall(skipParens(n.left))) found = true;
    else if (isNowCall(n, ["performance"])) found = true;
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && helpers.has(n.expression.text)) found = true;
    else ts.forEachChild(n, visit);
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

/** The tests of `source` that measure elapsed time without @timing: [{ line, title }]. */
export function untaggedTimingTests(source, fileName = "spec.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // The file's named functions (declarations and const arrows) that measure, to a fixpoint.
  const fns = new Map();
  const collect = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) fns.set(n.name.text, n.body);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))
      fns.set(n.name.text, n.initializer.body);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const helpers = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of fns) if (!helpers.has(name) && measures(body, helpers)) (helpers.add(name), (grew = true));
  }

  const out = [];
  const walk = (n, tagged) => {
    const kind = testCallKind(n);
    if (kind) {
      const title = titleOf(n, sf);
      const isTagged = tagged || title.includes(TAG);
      const body = n.arguments[n.arguments.length - 1];
      if (kind === "test") {
        if (!isTagged && body && measures(body, helpers)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, title });
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
  ];
  const failed = cases.filter(([, src, want]) => untaggedTimingTests(src).length !== want);
  for (const [name, src, want] of failed) console.error(`self-test "${name}": want ${want} untagged, got ${untaggedTimingTests(src).length}`);
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
  const bad = specs(join(web, "e2e")).flatMap((f) => untaggedTimingTests(readFileSync(f, "utf8"), f).map((t) => `${relative(web, f)}:${t.line} ${t.title}`));
  if (bad.length) {
    console.error(`These tests measure elapsed time; add ${TAG} to their titles so they run alone in e2e-timing:\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("check-timing-tags: every timing test is tagged @timing");
}
