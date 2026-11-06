import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";

import { expect, test } from "./test";

/**
 * Owner's decision (Nov 5), the source side of ground-truth-words.spec.ts: no string a page
 * can show, in web/app, web/components or web/lib (the mock API's data included), says
 * "Desired state", "Current state" or "Baseline" for the graph, including text that only shows
 * in a form or an empty state the walk does not open. Reads every string literal, template
 * piece and JSX text (comments aside). And no spec in web/e2e expects a page to say one: the
 * strings given to toHaveText, toContainText, getByText and a role's `name:` (test titles,
 * comments and checks that a text is gone aside).
 * fails_when = a label such as "change it in Baseline" or "Detailed › Baseline" is left, or a
 * spec still waits for "Baseline to PRD".
 *
 * What may still say baseline: an id by its shape (one lowercase word, or joined to "_ / . : -":
 * "baseline", "/baseline", "baseline-tab"), and a measure's starting value: "Baseline value",
 * "Baseline 12", "Success metric and baseline", and the "Baseline" field beside "Predicted" on a
 * decision's or an outcome's prediction.
 */

const WEB = path.resolve(__dirname, "..");

/** The old names as words of their own (an id joined to "_ / . : -" is not one; a full stop ends a sentence unless a word follows it). */
const OLD = /desired state|current state|(?<![\w/.:\-])baseline(?![\w/:\-]|\.\w)/i;
/**
 * A measure's starting value: "Baseline value", "Baseline 12", a table's "| Baseline |" column,
 * a prediction "above its baseline" (or "{} its baseline", the word filled in), "between the baseline and" the prediction, "the metric's
 * baseline", "No baseline for <a metric>".
 */
const STARTING_VALUE =
  /baseline value|baseline ?[:=]? ?[-+]?\d|success metric and baseline|\| ?baseline ?\||(?:above|below) its baseline\b|between the baseline and|metric's baseline|no baseline for|prediction must be \{\} its baseline/gi;
/** A lone id or key. */
const ID = /^[a-z][a-z0-9_]*$/;
/** The prediction forms' starting-value field, "Baseline" beside "Predicted". */
const PREDICTION_FIELD: Record<string, string> = {
  "app/company/decisions/_components/DecisionInspector.tsx": "Baseline",
  "app/plan/outcomes/page.tsx": "Baseline",
};

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) yield p;
  }
}

/** Whether a string in the file ``rel`` says an old name. */
function saysOld(rel: string, said: string): boolean {
  const word = said.trim();
  if (ID.test(word) || PREDICTION_FIELD[rel] === word) return false;
  return OLD.test(said.replace(STARTING_VALUE, ""));
}

const relOf = (file: string) => path.relative(WEB, file).split(path.sep).join("/");

const parse = (rel: string, text: string) =>
  ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** The text a string node says ("{}" for each value a template fills in), or null if it is no string. */
function textOf(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((span) => `{}${span.literal.text}`).join("");
  if (ts.isJsxText(n)) return n.getText();
  if (ts.isRegularExpressionLiteral(n)) return n.text.slice(1, n.text.lastIndexOf("/"));
  return null;
}

const where = (rel: string, src: ts.SourceFile, n: ts.Node, said: string) =>
  `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${JSON.stringify(said.trim().slice(0, 120))}`;

/** Every string the file ``rel`` (holding ``text``) says an old name in, as "file:line: text". */
function oldNames(rel: string, text: string): string[] {
  const src = parse(rel, text);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const said = ts.isRegularExpressionLiteral(n) ? null : textOf(n);
    if (said !== null && saysOld(rel, said)) out.push(where(rel, src, n, said));
    if (ts.isTemplateExpression(n)) n.templateSpans.forEach((span) => visit(span.expression));
    else ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The calls whose strings a spec expects a person to see. */
const ASSERTS = new Set(["toHaveText", "toContainText", "getByText"]);
/** A check that the text is not there: ".not.", toHaveCount(0) or toBeHidden(). */
const NEGATIVE = /\.not\.|toHaveCount\(0\)|toBeHidden\(/;

/** A table's "Baseline" column header, listed beside its "Target" column. */
const isMeasureColumn = (n: ts.Node) =>
  ts.isArrayLiteralExpression(n.parent) && n.parent.elements.some((e) => textOf(e) === "Target");

/** The statement ``n`` is part of. */
function statementOf(n: ts.Node): ts.Node {
  let at = n;
  while (at.parent && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent)) at = at.parent;
  return at;
}

/**
 * Every text a spec expects on the page that says an old name: the strings given to
 * toHaveText, toContainText and getByText, and every `name:` (a role's accessible name). Test
 * titles, comments and checks that the text is gone (".not.", toHaveCount(0)) are left out.
 */
function expectedOldNames(rel: string, text: string): string[] {
  const src = parse(rel, text);
  const out: string[] = [];
  const strings = (n: ts.Node, into: ts.Node[]) => {
    if (textOf(n) !== null) into.push(n);
    if (ts.isTemplateExpression(n)) n.templateSpans.forEach((span) => strings(span.expression, into));
    else ts.forEachChild(n, (c) => strings(c, into));
  };
  const visit = (n: ts.Node) => {
    const given: ts.Node[] = [];
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ASSERTS.has(n.expression.name.text)) {
      for (const arg of n.arguments) strings(arg, given);
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "name") {
      strings(n.initializer, given);
    }
    if (given.length && !NEGATIVE.test(statementOf(n).getText())) {
      for (const s of given) {
        const said = textOf(s)!;
        if (saysOld(rel, said) && !isMeasureColumn(s)) out.push(where(rel, src, s, said));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

const read = (file: string) => fs.readFileSync(file, "utf8");

test("no string a page can show in web/app, web/components or web/lib says Desired state, Current state or Baseline", () => {
  const found = ["app", "components", "lib"].flatMap((dir) => [...sources(path.join(WEB, dir))].flatMap((f) => oldNames(relOf(f), read(f))));
  expect(found).toEqual([]);
});

test("no spec in web/e2e expects a page to say Desired state, Current state or Baseline", () => {
  const found = [...sources(path.join(WEB, "e2e"))].flatMap((f) => expectedOldNames(relOf(f), read(f)));
  expect(found).toEqual([]);
});

test("the check catches the old names and spares the ids and the starting values", () => {
  for (const said of ["in the order; change it in Baseline", "Detailed › Baseline", "Baseline", "Current state", "Desired state", "Build the baseline", "Confirm the baseline."]) {
    expect(saysOld("app/x.tsx", said), said).toBe(true);
  }
  for (const kept of [
    "baseline",
    "/baseline",
    "baseline-tab",
    "baseline_confirm",
    "baseline.yaml",
    "Baseline value",
    "Baseline 12",
    "Success metric and baseline",
    "| Metric | Baseline | Target |",
    "an increase prediction must be above its baseline",
    "an {} prediction must be {} its baseline",
    "the partly-held line lies between the baseline and the prediction",
    "Ask for the metric's baseline before drafting",
    "No baseline for repeat checkout time",
  ]) {
    expect(saysOld("app/x.tsx", kept), kept).toBe(false);
  }
  expect(saysOld("app/plan/outcomes/page.tsx", "Baseline")).toBe(false);
});

test("the check finds an old name planted in web/lib, the mock and a spec's expectations, and spares titles, comments and negative checks", () => {
  // fails_when = the check does not read web/lib or web/e2e.
  expect(oldNames("lib/api/mock/runs.ts", 'export const F = { title: "Baseline to PRD" };')).toHaveLength(1);
  expect(oldNames("lib/flows.ts", "const label = `Change it in Baseline`;")).toHaveLength(1);
  expect(oldNames("lib/flows.ts", "const label = `${n} items in the ${where} Baseline`;")).toHaveLength(1);
  for (const planted of [
    'await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();',
    'await expect(page.getByTestId("t")).toHaveText("Detailed › Baseline");',
    'await expect(page.getByTestId("t")).toContainText(["Build the baseline"]);',
    "await page.getByText(/Current state/).click();",
  ]) {
    expect(expectedOldNames("e2e/x.spec.ts", planted), planted).toHaveLength(1);
  }
  for (const kept of [
    'test("Baseline to PRD reads Ground Truth to PRD", async () => {});',
    '// The heading once read "Baseline to PRD".',
    'await expect(page.getByText("Baseline to PRD")).toHaveCount(0);',
    'await expect(page.getByTestId("t")).not.toContainText("Baseline");',
    'await expect(page.getByRole("tab", { name: "Ground Truth" })).toBeVisible();',
    'await expect(table.getByRole("columnheader")).toHaveText(["Metric", "Baseline", "Target"]);',
  ]) {
    expect(expectedOldNames("e2e/x.spec.ts", kept), kept).toEqual([]);
  }
});
