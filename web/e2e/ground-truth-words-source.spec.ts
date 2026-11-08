import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";

import { expect, test } from "./test";

/**
 * Owner's decision (Nov 5), the source side of ground-truth-words.spec.ts: no string a page
 * can show, in web/app, web/components or web/lib (the mock API's data included), says
 * "Desired state", "Current state" or "Baseline" for the graph, including text that only shows
 * in a form or an empty state the walk does not open. Reads every string literal, template
 * piece and JSX text (comments aside), every string of the mock's JSON data, and every line of
 * the API's export and email templates (api/oracle's .j2 and .html, Jinja tags aside: the PDF,
 * deck and public roadmap exports, the invite emails), and every string the export builders in
 * Python write (api/oracle/export's .py: the PDF's render.py, the deck; docstrings, comments and
 * raw-string patterns aside), and the other Python that renders shown text (RENDERERS: the shared
 * page's render.py and public.py, the public roadmap page, the invite and minutes emails). And
 * no spec in web/e2e expects a page to say one: the strings given to toHaveText, toContainText,
 * getByText and a role's `name:` (test titles, comments and checks that a text is gone aside).
 * fails_when = a label such as "change it in Baseline" or "Detailed › Baseline" is left, or a
 * spec still waits for "Baseline to PRD".
 *
 * What may still say baseline: an id by its shape (one lowercase word, or joined to "_ / . : -":
 * "baseline", "/baseline", "baseline-tab"), and a measure's starting value: "Baseline value",
 * "Baseline 12", "Success metric and baseline", and the "Baseline" field beside "Predicted" on a
 * decision's or an outcome's prediction. And a CSS value ("align-items: baseline").
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
/** A CSS property set to baseline ("align-items: baseline", "vertical-align: baseline"): a value, not a word. */
const CSS_VALUE = /\b(?:vertical-align|(?:align|justify|place)-(?:items|self|content)|(?:alignment|dominant)-baseline)\s*:\s*(?:(?:first|last)\s+)?baseline\b/g;
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
  return OLD.test(said.replace(STARTING_VALUE, "").replace(CSS_VALUE, ""));
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

/** Every string in a JSON value, keys included. */
function* jsonStrings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* jsonStrings(x);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      yield k;
      yield* jsonStrings(x);
    }
  }
}

/** Every string of the mock's JSON data file ``rel`` (holding ``text``) that says an old name. */
const jsonOldNames = (rel: string, text: string) => [...jsonStrings(JSON.parse(text))].filter((s) => saysOld(rel, s)).map((s) => `${rel}: ${JSON.stringify(s.trim().slice(0, 120))}`);

const MOCK = path.join(WEB, "lib", "api", "mock");
const API = path.resolve(WEB, "..", "api", "oracle");
/** A Jinja tag, expression or comment: code, not words a person reads. */
const JINJA = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;

function* templates(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* templates(p);
    else if (/\.(j2|html)$/.test(e.name)) yield p;
  }
}

/** Every line of an export or email template ``rel`` (holding ``text``) that says an old name, its tags aside. */
function templateOldNames(rel: string, text: string): string[] {
  // A tag over several lines keeps its line breaks, so each line keeps its number.
  const lines = text.replace(JINJA, (m) => "{}" + "\n".repeat(m.split("\n").length - 1)).split("\n");
  return lines.flatMap((line, i) => (saysOld(rel, line) ? [`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
}

const EXPORT = path.join(API, "export");

/** A Python comment, or a string's prefix and opening quote. */
const PY_TOKEN = /#[^\n]*|(?<!\w)([rRbBuUfF]{0,2})("""|'''|"|')/g;

/**
 * Every string of the Python file ``text`` a person can read, as [line, text]: an f-string's
 * {…} reads "{}"; docstrings (a string alone after a "…:" line or at the top), comments, raw
 * strings (patterns) and bytes are left out.
 */
function pythonStrings(text: string): [number, string][] {
  const out: [number, string][] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  let m: RegExpExecArray | null;
  PY_TOKEN.lastIndex = 0;
  while ((m = PY_TOKEN.exec(text))) {
    if (m[0].startsWith("#")) continue;
    const prefix = m[1].toLowerCase();
    const quote = m[2];
    const start = PY_TOKEN.lastIndex;
    let i = start;
    while (i < text.length && !text.startsWith(quote, i)) i += text[i] === "\\" ? 2 : 1;
    PY_TOKEN.lastIndex = i + quote.length;
    if (prefix.includes("r") || prefix.includes("b")) continue;
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const lineEnd = text.indexOf("\n", PY_TOKEN.lastIndex);
    const alone = !text.slice(lineStart, m.index).trim() && /^\s*(#.*)?$/.test(text.slice(PY_TOKEN.lastIndex, lineEnd < 0 ? undefined : lineEnd));
    const above = text.slice(0, lineStart).split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    if (alone && (!above.length || above[above.length - 1].endsWith(":"))) continue;
    let body = text.slice(start, i);
    if (prefix.includes("f")) body = body.replace(/\{\{|\}\}|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, (x) => (x === "{{" ? "{" : x === "}}" ? "}" : "{}"));
    body.split("\n").forEach((l, k) => out.push([lineAt(m!.index) + k, l]));
  }
  return out;
}

/** Every string an export builder in Python ``rel`` (holding ``text``) writes that says an old name. */
const pythonOldNames = (rel: string, text: string) =>
  pythonStrings(text).flatMap(([line, said]) => (saysOld(rel, said) ? [`${rel}:${line}: ${said.trim().slice(0, 120)}`] : []));

/**
 * The other Python that writes text a person reads, each named: the shared page's renderer and
 * its public route, the public roadmap page and the roadmap views they draw, the invite email
 * and its send, and the meeting minutes email (meetings.py's deliver).
 */
const RENDERERS = [
  "shares/render.py",
  "shares/public.py",
  "roadmap/public.py",
  "roadmap/variants.py",
  "members/mailer.py",
  "members/delivery.py",
  "simple/meetings.py",
];

const builders = () => [
  ...fs.readdirSync(EXPORT).filter((f) => f.endsWith(".py")).map((f) => path.join(EXPORT, f)),
  ...RENDERERS.map((f) => path.join(API, f)),
];

test("no string a page can show in web/app, web/components or web/lib says Desired state, Current state or Baseline", () => {
  const found = ["app", "components", "lib"].flatMap((dir) => [...sources(path.join(WEB, dir))].flatMap((f) => oldNames(relOf(f), read(f))));
  expect(found).toEqual([]);
});

test("no string of the mock's JSON data, an export or email template, nor a Python export builder, shared page or email says Desired state, Current state or Baseline", () => {
  const mock = fs.readdirSync(MOCK).filter((f) => f.endsWith(".json")).flatMap((f) => jsonOldNames(relOf(path.join(MOCK, f)), read(path.join(MOCK, f))));
  const sent = [...templates(API)].flatMap((f) => templateOldNames(path.relative(API, f), read(f)));
  const built = builders().flatMap((f) => pythonOldNames(path.relative(API, f), read(f)));
  expect([...mock, ...sent, ...built]).toEqual([]);
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
    ".row { display: flex; align-items: baseline; }",
    "vertical-align: baseline",
    "align-self:first baseline",
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
  // fails_when = the check does not read the mock's JSON data or the exports' and emails' templates.
  expect(jsonOldNames("lib/api/mock/x.json", '{"items": [{"title": "Change it in Baseline", "key": "baseline"}]}')).toHaveLength(1);
  expect(templateOldNames("export/templates/deck.html.j2", "<h1>{{ title }}</h1>\n<p>Read from the Baseline.</p>\n<p>{{ item.baseline }}</p>")).toEqual(["export/templates/deck.html.j2:2: <p>Read from the Baseline.</p>"]);
  expect(templateOldNames("members/invite-email.html", '<p class="baseline-row">{# the\nbaseline #}</p>\n<p>Change it in Baseline</p>')).toEqual(["members/invite-email.html:3: <p>Change it in Baseline</p>"]);
  expect([...templates(API)].length, "the API's export and email templates are found").toBeGreaterThan(0);
  // fails_when = the check does not read the strings the export builders in Python write.
  const py = [
    '"""The deck: Baseline slides."""',
    "import re",
    "_PATTERN = re.compile(r\"\\bBaseline\\b\")  # Read from the Baseline",
    "def title(where: str) -> str:",
    '    """Read from the Baseline."""',
    "    return f\"<h2>{where} {{Baseline}}</h2>\"",
    "",
    "CSS = '.kpi { align-items: baseline; }'",
    'NOTE = ("Kept as is", "Change it in Current state")',
    'BODY = """',
    "<p>Read from the Desired state.</p>",
    '"""',
  ].join("\n");
  expect(pythonOldNames("export/deck.py", py)).toEqual([
    "export/deck.py:6: <h2>{} {Baseline}</h2>",
    "export/deck.py:9: Change it in Current state",
    "export/deck.py:11: <p>Read from the Desired state.</p>",
  ]);
  expect(builders().map((f) => path.basename(f)), "the PDF's and the deck's builders are read").toEqual(expect.arrayContaining(["render.py", "deck.py"]));
  // fails_when = the check does not read the Python that renders shared pages and emails.
  const named = builders().map((f) => path.relative(API, f));
  expect(named, "the shared page's and the emails' renderers are read").toEqual(expect.arrayContaining(RENDERERS));
  for (const f of RENDERERS) expect(fs.existsSync(path.join(API, f)), f).toBe(true);
  expect(pythonOldNames("shares/render.py", 'TITLE = "Shared from the Baseline"\nKEY = "baseline"\nhref = f"/baseline/{slug}"')).toEqual([
    "shares/render.py:1: Shared from the Baseline",
  ]);
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
