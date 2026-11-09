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
 * deck and public roadmap exports, the invite emails), and every string of the Python that writes
 * shown text, found by itself, none listed by hand (shownModules: each api/oracle module that
 * renders HTML, email or chat, and the modules of its own or a sibling package it imports, an
 * agents' task module too; docstrings, comments, raw-string patterns, real log calls and the
 * LLM's prompts aside, a prompt found by its name or by its text going only to model calls).
 * And no spec in web/e2e
 * expects a page to say one: the strings given to toHaveText, toContainText, getByText and a
 * role's `name:` (test titles, comments and checks that a text is gone aside).
 * fails_when = a label such as "change it in Baseline" or "Detailed › Baseline" is left, a
 * renderer (a brand-new one too) writes "Read from the Baseline", or a spec still waits for
 * "Baseline to PRD".
 *
 * What may still say baseline: an id by its shape (one lowercase word, or joined to
 * "_ / . : -": "baseline", "/baseline", "baseline-tab"), and a measure's starting value:
 * "Baseline value", "Baseline 12", "Success metric and baseline", and the "Baseline" field
 * beside "Predicted" on a decision's or an outcome's prediction. And a CSS value
 * ("align-items: baseline"). In the Python only, an id written as code in a sentence: a
 * backtick span that is one lowercase id holding "_ . / : < {" ("`baseline.yaml`") or a command
 * starting "oracle " ("`oracle baseline pull`"), a quoted id with a <placeholder>
 * ('"baseline decision <key>"'), or, in api/oracle/runs/flows.py only, these exact words in any of
 * its strings: 'never "baseline" (except a goal's or key result's starting value)', the quotes
 * escaped or not (the rest of the string is still read).
 * 'Open the "baseline" page', "Read `Baseline` first", "`build the baseline.`",
 * 'Saved to "baseline {q}"', 'not "baseline"' and 'This is never "baseline" data.' are caught.
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
/**
 * In the Python's text, an id written as code in a sentence: a backtick span that is an id (no spaces,
 * lowercase, holding one of "_ . / : < {": "`baseline.yaml`") or a command (lowercase words starting
 * "oracle ": "`oracle baseline pull`"). A span of words ("`build the baseline.`") is shown text.
 */
const CODE_SPAN = /`([^`\n]*)`/g;
const isCode = (span: string) =>
  /^[a-z0-9_./:<>{}-]*[_./:<{][a-z0-9_./:<>{}-]*$/.test(span) || /^oracle(?: [a-z0-9_./:<>{}-]+)+$/.test(span);
/**
 * ... or a quoted id with a <placeholder> ('"baseline decision <key>"', a citation's ref; an f-string's fill
 * is no placeholder), or, in api/oracle/runs/flows.py only, the exact words of PROMPT_LINE_AVOID in any of its
 * strings (the quotes escaped or not; the rest of the string is still read): any other 'never "baseline"' is shown text.
 */
const QUOTED_ID = /\\?(["'])[a-z][a-z0-9_]*(?: [a-z][a-z0-9_]*)* <\w+>\\?\1/g;
const PROMPT_LINE_FILE = "runs/flows.py";
const PROMPT_LINE_AVOID = /\bnever \\?"baseline\\?" \(except a goal's or key result's starting value\)/g;
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
  let text = said.replace(STARTING_VALUE, "").replace(CSS_VALUE, "");
  if (rel.endsWith(".py")) text = text.replace(CODE_SPAN, (m, span) => (isCode(span) ? "" : m)).replace(QUOTED_ID, "");
  if (rel === PROMPT_LINE_FILE) text = text.replace(PROMPT_LINE_AVOID, "");
  return OLD.test(text);
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


/** A Python comment, or a string's prefix and opening quote. */
const PY_TOKEN = /#[^\n]*|(?<!\w)([rRbBuUfF]{0,2})("""|'''|"|')/g;

/** A Python string (``body`` its text) or comment (``body`` null): where it starts and ends, its prefix, and whether it is a docstring. */
type PyToken = { at: number; end: number; prefix: string; body: string | null; doc: boolean };

/** Where each line of ``text`` starts, in order. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The line (from 1) of the offset ``at``, by its file's ``starts``. */
function lineOf(starts: number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Every string and comment of the Python file ``text``, in one pass. */
function pythonTokens(text: string): PyToken[] {
  const out: PyToken[] = [];
  const re = new RegExp(PY_TOKEN.source, "g");
  // The last line above the one being read that holds code (its comment aside), and where reading stopped.
  let above = "";
  let scanned = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].startsWith("#")) {
      out.push({ at: m.index, end: re.lastIndex, prefix: "", body: null, doc: false });
      continue;
    }
    const quote = m[2];
    const start = re.lastIndex;
    let i = start;
    while (i < text.length && !text.startsWith(quote, i)) i += text[i] === "\\" ? 2 : 1;
    re.lastIndex = i + quote.length;
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    for (; scanned < lineStart; ) {
      const nl = text.indexOf("\n", scanned);
      const line = text.slice(scanned, nl).replace(/#.*$/, "").trim();
      if (line) above = line;
      scanned = nl + 1;
    }
    const lineEnd = text.indexOf("\n", re.lastIndex);
    const alone = !text.slice(lineStart, m.index).trim() && /^\s*(#.*)?$/.test(text.slice(re.lastIndex, lineEnd < 0 ? undefined : lineEnd));
    const doc = alone && (!above || above.endsWith(":"));
    out.push({ at: m.index, end: re.lastIndex, prefix: m[1].toLowerCase(), body: text.slice(start, i), doc });
  }
  return out;
}

/** The code of the Python file ``text`` (its ``tokens``), each string and comment a space. */
function pythonCode(text: string, tokens: PyToken[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const t of tokens) {
    parts.push(text.slice(at, t.at), " ".repeat(t.end - t.at));
    at = t.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** A Python file read once: its strings and comments, its code (those blanked) and where its lines start. */
type PyParsed = { tokens: PyToken[]; code: string; starts: number[] };

const parsedPython = new Map<string, PyParsed>();

/** The Python file ``text`` read once, then kept: rendersText, oracleImports and pythonStrings share it. */
function parsePython(text: string): PyParsed {
  let parsed = parsedPython.get(text);
  if (!parsed) {
    const tokens = pythonTokens(text);
    parsed = { tokens, code: pythonCode(text, tokens), starts: lineStarts(text) };
    parsedPython.set(text, parsed);
  }
  return parsed;
}

/**
 * A call on a real logger, its text going to the server's log, never to a person: the logging
 * module or a logger object (log.info(...), logger.warning(...), logging.error(...), LOG.debug(...),
 * self.log.info(...), self.logger.info(...)), a warning (warnings.warn(...)), or a print (kept only
 * when it writes to stderr: printLogs). A bare self.log(...) is a method of its own, and may well
 * write text a person reads.
 */
const LOG_CALL =
  /(?<![\w.])(?:(?:self\.)?_?log(?:ger)?|logging|LOG)\.(?:debug|info|warning|warn|error|exception|critical|log)\s*\(|(?<![\w.])warnings\.warn\s*\(|(?<![\w.])print\s*\(/g;

/**
 * A hook that writes an LLM's prompt by its name (a def named for it: prompt_lines, a run's *_prompt_lines,
 * any name ending in prompt such as system_prompt or build_prompt, or starting with _prompt): the model reads
 * its text, a person never does. A function whose text is passed to a model call is one too, by any name
 * (promptBuilders).
 */
const PROMPT_HOOK = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(?:\w*prompt(?:_lines)?|_prompt\w*)[ \t]*\(/gm;

/** A call on the model (the LLM gateway's or a transport's complete, an SDK's messages.create): the text it is given is a prompt. */
const MODEL_CALL = /(?<![\w.])(?:\w+\.)*(?:gateway|transport|client|llm)\.complete\s*\(|\.messages\.create\s*\(/g;

/** Where the bracket open at ``from`` in ``code`` closes (just past it). */
function closing(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i]) && --depth === 0) return i + 1;
  }
  return code.length;
}

/** The spans of the log calls in ``code`` (a Python file's code, its strings blanked); a print only when it writes to stderr. */
const logCalls = (code: string): [number, number][] =>
  [...code.matchAll(LOG_CALL)].flatMap((m) => {
    const span: [number, number] = [m.index, closing(code, m.index + m[0].length - 1)];
    return !m[0].startsWith("print") || /\bfile\s*=\s*(?:\w+\s+or\s+)?sys\.stderr\b/.test(code.slice(...span)) ? [span] : [];
  });

/**
 * The spans of the prompt hooks in ``code`` (a Python file's code, its strings blanked): each def named
 * for a prompt, or named in ``fed`` (its text goes to the model), to the next line indented no deeper than it.
 */
function promptHooks(code: string, fed?: Set<string>): [number, number][] {
  const hooks = [...code.matchAll(PROMPT_HOOK)];
  if (fed?.size) hooks.push(...code.matchAll(new RegExp(`^([ \\t]*)(?:async[ \\t]+)?def[ \\t]+(?:${[...fed].join("|")})[ \\t]*\\(`, "gm")));
  return hooks.map((m) => {
    const body = closing(code, m.index + m[0].length - 1);
    const next = code.slice(body).search(new RegExp(`\\n(?!${m[1]}[ \\t]|[ \\t]*\\n)`));
    return [m.index, next < 0 ? code.length : body + next];
  });
}

/**
 * Every string of the Python file ``text`` a person can read, as [line, text]: an f-string's
 * {…} reads "{}"; docstrings (a string alone after a "…:" line or at the top), comments, raw
 * strings (patterns), bytes, and the text of log calls and prompt hooks (those named for a prompt,
 * and the functions ``fed`` names, whose text goes to the model) are left out.
 */
function pythonStrings(text: string, fed?: Set<string>): [number, string][] {
  const out: [number, string][] = [];
  const { tokens, code, starts } = parsePython(text);
  const unread = [...logCalls(code), ...promptHooks(code, fed)];
  for (const t of tokens) {
    if (t.body === null || t.doc || t.prefix.includes("r") || t.prefix.includes("b")) continue;
    if (unread.some(([a, b]) => a <= t.at && t.at < b)) continue;
    let body = t.body;
    if (t.prefix.includes("f")) body = body.replace(/\{\{|\}\}|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, (x) => (x === "{{" ? "{" : x === "}}" ? "}" : "{}"));
    const line = lineOf(starts, t.at);
    body.split("\n").forEach((l, k) => out.push([line + k, l]));
  }
  return out;
}

/** Every string a Python module ``rel`` (holding ``text``, ``fed`` its functions whose text goes to the model) that shows text writes and that says an old name. */
const pythonOldNames = (rel: string, text: string, fed?: Set<string>) =>
  pythonStrings(text, fed).flatMap(([line, said]) => (saysOld(rel, said) ? [`${rel}:${line}: ${said.trim().slice(0, 120)}`] : []));

/**
 * What marks a Python module as one that writes text a person reads, in its code: HTML (html or
 * markupsafe escaping, an HTMLResponse, Jinja, the PDF, the shared page's frame), email (the
 * mailer, an EmailMessage, smtplib) or chat (the Slack API, its outbox).
 */
const RENDERS_IN_CODE =
  /\bimport html\b|\bfrom html import\b|\bmarkupsafe\b|\bHTMLResponse\b|\bjinja2\b|\b_jinja\(|\bhtml_to_pdf\b|\brender\.page\(|\bmailer\b|\bEmailMessage\b|\bsmtplib\b|\bslack_api\b|\bslack_oauth\b|\bSlackOutbox\b/;
/**
 * ... or in its strings (docstrings aside): an HTML page's type or tag ("<p>", '<a href="…">',
 * "</li>", not a placeholder such as "<section id>"), a Slack post or its mrkdwn.
 */
const RENDERS_IN_STRINGS =
  /text\/html|chat\.postMessage|\bmrkdwn\b|<\/?(?:html|body|head|p|div|span|section|header|footer|main|h[1-6]|table|thead|tbody|tr|td|th|ul|ol|li|strong|em|a|br|style)(?:\s[^<>\n]*=[^<>\n]*)?\s*\/?>/i;

/** Python whose text no person reads: tests, and the LLM's prompts (kept in a prompts folder, or a module named for them). */
const NOT_SHOWN = /(?:^|\/)(?:tests?|prompts?)\/|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest|[^/]*prompts?|prompting)\.py$/;

/** Whether the Python module ``rel`` (holding ``text``) writes text a person reads, by what it writes to. */
function rendersText(rel: string, text: string): boolean {
  if (NOT_SHOWN.test(rel)) return false;
  const { tokens, code } = parsePython(text);
  if (RENDERS_IN_CODE.test(code)) return true;
  return tokens.some((t) => t.body !== null && !t.doc && RENDERS_IN_STRINGS.test(t.body));
}

/** One "from … import …" of an api/oracle package: the package (as path parts under api/oracle) and each name it imports, with the name it takes. */
type OracleImport = { pkg: string[]; names: [string, string][] };

/** The "from oracle… import …" and "from .… import …" lines of the Python module ``rel`` (holding ``text``). */
function oracleImportLines(rel: string, text: string): OracleImport[] {
  const out: OracleImport[] = [];
  const { code } = parsePython(text);
  const here = path.posix.dirname(rel).split("/").filter((p) => p !== ".");
  for (const m of code.matchAll(/^[ \t]*from (?:oracle((?:\.\w+)*)|(\.+)(\w+(?:\.\w+)*)?) import (\([^)]*\)|[^\n]*)/gm)) {
    // A relative import starts in the module's own package; each dot past the first goes up one.
    const base = m[2] === undefined ? [] : here.slice(0, Math.max(0, here.length - (m[2].length - 1)));
    const pkg = [...base, ...(m[2] === undefined ? m[1].slice(1) : (m[3] ?? "")).split(".").filter(Boolean)];
    const names = m[4]
      .replace(/[()\\]/g, " ")
      .split(",")
      .flatMap((name): [string, string][] => {
        const words = name.trim().split(/\s+/);
        return words[0] ? [[words[0], words[1] === "as" && words[2] ? words[2] : words[0]]] : [];
      });
    out.push({ pkg, names });
  }
  return out;
}

/**
 * The api/oracle modules (as paths under it, "roadmap/variants.py") the Python module ``rel`` (holding
 * ``text``) imports from, "from oracle.roadmap import …" and "from .variants import …" alike, and the
 * names it imports as modules of their own.
 */
function oracleImports(rel: string, text: string): string[] {
  const out: string[] = [];
  for (const { pkg, names } of oracleImportLines(rel, text)) {
    if (pkg.length) out.push(pkg.join("/") + ".py");
    for (const [name] of names) out.push([...pkg, name].join("/") + ".py");
  }
  for (const m of parsePython(text).code.matchAll(/^[ \t]*import oracle((?:\.\w+)+)/gm)) out.push(m[1].slice(1).split(".").join("/") + ".py");
  return out;
}

/** Where the statement going on at ``from`` in ``code`` ends: the first line end outside brackets. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if ("([{".includes(code[i])) depth++;
    else if (")]}".includes(code[i])) depth--;
    else if (code[i] === "\n" && depth <= 0) return i;
  }
  return code.length;
}

/** The calls in ``code`` by name and where each starts: "build(…)" as ["build"], "lines.facts(…)" as ["lines", "facts"]. */
const callsIn = (code: string) =>
  [...code.matchAll(/(?<![\w.])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\(/g)].map((m) => [m[1], m[2], m.index] as const);

/** The arguments of a model call (inside its brackets) with only the text ones kept, the rest blanked: every positional one and the keywords a prompt goes by (system=, messages=, prompt=…), not model= or job=. */
function textArgs(args: string): string {
  const parts: string[] = [];
  let [depth, at] = [0, 0];
  for (let i = 0; i <= args.length; i++) {
    if (i === args.length || (args[i] === "," && depth === 0)) {
      parts.push(args.slice(at, i));
      at = i + 1;
    } else if ("([{".includes(args[i])) depth++;
    else if (")]}".includes(args[i])) depth--;
  }
  return parts.map((a) => (!/^\s*\w+\s*=(?!=)/.test(a) || /^\s*(?:system|messages|prompt|content|user|input)\s*=/.test(a) ? a : " ".repeat(a.length))).join(",");
}

/**
 * The functions of ``files`` (path under api/oracle → text) whose returned text goes to the model,
 * by module: each called in a model call's arguments ("complete(db, build_system(run), …)"), or
 * called to set a name given there ("system = intro(run)" in the same function), whether defined in
 * the module itself or imported from another ("from .lines import facts", "lines.facts()"). Only
 * when every call to it, in any module, feeds a model: one whose text also goes into an email is read.
 */
function promptBuilders(files: Map<string, string>): Map<string, Set<string>> {
  // Each call, as "module:offset", by the function it calls ("module:name").
  const fedCalls = new Map<string, Set<string>>();
  // Each module's own functions and its imports, read once.
  const known = new Map<string, { own: Set<string>; imported: OracleImport[] }>();
  /** The functions (as "module:name") the call ``a``(…) or ``a.b``(…) in ``rel`` reaches. */
  const reached = (rel: string, a: string, b: string | undefined): string[] => {
    let k = known.get(rel);
    if (!k) {
      const text = files.get(rel)!;
      const own = new Set([...parsePython(text).code.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm)].map((m) => m[1]));
      known.set(rel, (k = { own, imported: oracleImportLines(rel, text) }));
    }
    if (b === undefined && k.own.has(a)) return [`${rel}:${a}`];
    if (b !== undefined && a === "self" && k.own.has(b)) return [`${rel}:${b}`];
    return k.imported.flatMap(({ pkg, names }) =>
      names.flatMap(([name, as]) =>
        as !== a ? [] : [b === undefined ? `${pkg.join("/")}.py:${name}` : `${[...pkg, name].join("/")}.py:${b}`],
      ),
    );
  };
  const feed = (rel: string, calls: ReturnType<typeof callsIn>, offset: number) => {
    for (const [a, b, at] of calls) {
      for (const fn of reached(rel, a, b)) {
        if (files.has(fn.slice(0, fn.lastIndexOf(":")))) (fedCalls.get(fn) ?? fedCalls.set(fn, new Set()).get(fn)!).add(`${rel}:${offset + at}`);
      }
    }
  };
  for (const [rel, text] of files) {
    if (!text.includes(".complete(") && !text.includes(".messages.create(")) continue;
    const { code } = parsePython(text);
    for (const m of code.matchAll(MODEL_CALL)) {
      const open = m.index + m[0].length - 1;
      const args = textArgs(code.slice(open + 1, closing(code, open) - 1));
      feed(rel, callsIn(args), open + 1);
      // A name given to the call: what set it, in the same function, before the call.
      const fn = Math.max(0, code.lastIndexOf("def ", m.index));
      const before = code.slice(fn, m.index);
      for (const [, name] of args.matchAll(/(?<![\w.])([A-Za-z_]\w*)\b(?!\s*[=(.\w])/g)) {
        for (const set of before.matchAll(new RegExp(`^[ \\t]*(?:\\w+[ \\t]*,[ \\t]*)*${name}(?:[ \\t]*,[ \\t]*\\w+)*[ \\t]*(?::[^=\\n]*)?=(?!=)`, "gm"))) {
          const at = set.index + set[0].length;
          feed(rel, callsIn(before.slice(at, statementEnd(before, at))), fn + at);
        }
      }
    }
  }
  // Every call to those functions, in any module that names one: a call that feeds no model keeps it read.
  const names = new Set([...fedCalls.keys()].map((fn) => fn.slice(fn.lastIndexOf(":") + 1)));
  const named = new RegExp(`(?<![\\w])(?:${[...names].join("|")})\\s*\\(`);
  const read = new Set<string>();
  for (const [rel, text] of files) {
    if (!names.size || !named.test(text)) continue;
    const code = parsePython(text).code.replace(/\bdef[ \t]+\w+/g, (d) => " ".repeat(d.length));
    for (const [a, b, at] of callsIn(code)) {
      if (!names.has(b ?? a)) continue;
      for (const fn of reached(rel, a, b)) if (fedCalls.has(fn) && !fedCalls.get(fn)!.has(`${rel}:${at}`)) read.add(fn);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const fn of fedCalls.keys()) {
    if (read.has(fn)) continue;
    const [rel, name] = [fn.slice(0, fn.lastIndexOf(":")), fn.slice(fn.lastIndexOf(":") + 1)];
    (out.get(rel) ?? out.set(rel, new Set()).get(rel)!).add(name);
  }
  return out;
}

/** Whether a helper ``dep`` the module ``rel`` imports is in its own package or a sibling one (both in the same parent package). */
function nearby(rel: string, dep: string): boolean {
  const [r, d] = [path.posix.dirname(rel), path.posix.dirname(dep)];
  return r !== "." && d !== "." && (r === d || path.posix.dirname(r) === path.posix.dirname(d));
}

/**
 * The Python modules of ``files`` (path under api/oracle → text) that write text a person reads,
 * found by themselves: each that renders HTML, email or chat (rendersText), and the modules of its
 * own package or a sibling package it imports, which build the text it renders (the roadmap views
 * the public roadmap draws). Tests and prompt modules aside; a module writing an agents' task is read, as it
 * may also hold titles people see (runs/flows.py, the flows' titles).
 */
function shownModules(files: Map<string, string>): string[] {
  const renderers = [...files].filter(([rel, text]) => rendersText(rel, text));
  const helpers = renderers.flatMap(([rel, text]) =>
    oracleImports(rel, text).filter((dep) => nearby(rel, dep) && files.has(dep)),
  );
  return [...new Set([...renderers.map(([rel]) => rel), ...helpers])].filter((rel) => files.has(rel) && !NOT_SHOWN.test(rel)).sort();
}

function* pythonModules(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__pycache__") yield* pythonModules(p);
    } else if (e.name.endsWith(".py")) yield p;
  }
}

const pyRel = (f: string) => path.relative(API, f).split(path.sep).join("/");

/** Every Python module under api/oracle, path → text, read once. */
let apiPythonFiles: Map<string, string> | undefined;
const apiPython = () => (apiPythonFiles ??= new Map([...pythonModules(API)].map((f) => [pyRel(f), read(f)])));

/** The api/oracle modules that write shown text, found once: the word test and its self-test share them. */
let apiShownModules: string[] | undefined;
const apiShown = () => (apiShownModules ??= shownModules(apiPython()));

/** The api/oracle functions whose text goes to the model, by module, found once. */
let apiPromptBuilders: Map<string, Set<string>> | undefined;
const apiFed = () => (apiPromptBuilders ??= promptBuilders(apiPython()));

test("no string a page can show in web/app, web/components or web/lib says Desired state, Current state or Baseline", () => {
  const found = ["app", "components", "lib"].flatMap((dir) => [...sources(path.join(WEB, dir))].flatMap((f) => oldNames(relOf(f), read(f))));
  expect(found).toEqual([]);
});

test("no string of the mock's JSON data, an export or email template, nor the Python that writes shown text (an export, a shared or public page, an email, a Slack post) says Desired state, Current state or Baseline", () => {
  const mock = fs.readdirSync(MOCK).filter((f) => f.endsWith(".json")).flatMap((f) => jsonOldNames(relOf(path.join(MOCK, f)), read(path.join(MOCK, f))));
  const sent = [...templates(API)].flatMap((f) => templateOldNames(path.relative(API, f), read(f)));
  const python = apiPython();
  const fed = apiFed();
  const built = apiShown().flatMap((rel) => pythonOldNames(rel, python.get(rel)!, fed.get(rel)));
  expect([...mock, ...sent, ...built]).toEqual([]);
});

test("no spec in web/e2e expects a page to say Desired state, Current state or Baseline", () => {
  const found = [...sources(path.join(WEB, "e2e"))].flatMap((f) => expectedOldNames(relOf(f), read(f)));
  expect(found).toEqual([]);
});

test("the check catches the old names and spares the ids and the starting values", () => {
  for (const said of [
    "in the order; change it in Baseline",
    "Detailed › Baseline",
    "Baseline",
    "Current state",
    "Desired state",
    "Build the baseline",
    "Confirm the baseline.",
    'Say "build the baseline" to start',
    "Read the `x` baseline",
    'Open the "baseline" page',
    "Open the 'baseline' page",
    "Read `Baseline` first",
    "*Moved:* `Build the baseline`",
    "See the `the Baseline view` tab",
    'text you write, never "baseline" (except a starting value)',
    "as get_baseline and `oracle baseline pull` give it",
    "*Moved:* `build the baseline.`",
    'Saved to "baseline {}"',
    'Pick a view, not "baseline"',
  ]) {
    expect(saysOld("app/x.tsx", said), said).toBe(true);
  }
  // fails_when = shown text in the Python passes as an id: a quoted word with no <placeholder> (an
  // f-string's fill is no placeholder) and no "never", or a backtick span that is not an id or a command.
  for (const said of [
    'Open the "baseline" page',
    "Open the 'baseline' page",
    "Read `Baseline` first",
    "*Moved:* `Build the baseline`",
    "See the `the Baseline view` tab",
    "*Moved:* `build the baseline.`",
    'Saved to "baseline {}"',
    'Pick a view, not "baseline"',
    "Use the plan instead of 'baseline'",
  ]) {
    expect(saysOld("slack/pings.py", said), said).toBe(true);
  }
  // fails_when = the prompt line's wording is spared in every Python module, not only in runs/flows.py.
  for (const said of [
    'text you write, never "baseline" (except a starting value)',
    'Your roadmap is never "baseline" (except when imported).',
  ]) {
    expect(saysOld("slack/pings.py", said), said).toBe(true);
  }
  // fails_when = the 'never "baseline"' allowance spares any shown message, not only the agents' prompt line.
  for (const said of ['This is never "baseline" data.', 'This is never \\"baseline\\" data.', "Never 'baseline' here"]) {
    expect(saysOld("runs/flows.py", said), said).toBe(true);
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
  // An id written as code in the Python's text for agents: the citation ref, a CLI command, a word to avoid.
  for (const kept of [
    'text you write, never "baseline" (except a goal\'s or key result\'s starting value).',
    'text you write, never \\"baseline\\" (except a goal\'s or key result\'s starting value).',
    'e.g. "baseline decision <key>": an identifier Oracle reads',
    "as get_baseline and `oracle baseline pull` give it",
    "write it to `baseline.yaml`",
  ]) {
    expect(saysOld("runs/flows.py", kept), kept).toBe(false);
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
  // fails_when = a module that renders HTML, email or chat is missed because no list names it.
  const shown = apiShown();
  expect(shown, "the export builders, shared and public pages, emails and Slack posts are found").toEqual(
    expect.arrayContaining([
      "export/render.py",
      "export/deck.py",
      "shares/render.py",
      "shares/public.py",
      "roadmap/public.py",
      "roadmap/variants.py",
      "members/mailer.py",
      "members/delivery.py",
      "simple/meetings.py",
      "simple/one_pager.py",
      "jobs/router.py",
      "slack/pings.py",
    ]),
  );
  expect(shown.filter((rel) => NOT_SHOWN.test(rel)), "no test or prompt module is read").toEqual([]);
  // fails_when = a module is skipped whole for writing an agents' task: runs/flows.py also holds the
  // flows' titles people see (FLOWS[...].title, read by members/tokens.py and others).
  expect(shown, "the flows' titles (runs/flows.py) are read").toContain("runs/flows.py");
  expect(pythonOldNames("shares/render.py", 'TITLE = "Shared from the Baseline"\nKEY = "baseline"\nhref = f"/baseline/{slug}"')).toEqual([
    "shares/render.py:1: Shared from the Baseline",
  ]);
  // fails_when = a brand-new renderer, or a helper it imports from its own package (by name or by a
  // relative import) or from a sibling package, says Baseline and is not read; a model's own method
  // named log, or print to the screen, is skipped as a log call; or a real log call (the logging
  // module, a logger, print to stderr), a warning, a prompt hook, a function whose text goes to the
  // model or a prompt module (one named for prompts, reached from a sibling package) trips the check;
  // or a module writing an agent's task (task=, a *_TASK constant) hides the title it also shows.
  const planted = new Map([
    [
      "digest/email.py",
      [
        "from email.message import EmailMessage",
        "from oracle.digest import (",
        "    lines,",
        ")",
        "",
        "def send(to: str) -> EmailMessage:",
        "    msg = EmailMessage()",
        '    msg.set_content(f"Hi {to}, read what changed in the Baseline.")',
        '    log.info("digest for %s skipped the Baseline", to)',
        "    return msg",
        "",
        "def prompt_lines(",
        "    run: str,",
        ") -> list[str]:",
        '    return [f"Never say Baseline for the graph ({run})."]',
        "",
        "def footer() -> str:",
        '    return "Sent from the Baseline"',
        "",
        "def summary_prompt(run: str) -> str:",
        '    return f"Read the Baseline of {run}."',
        "",
        "def _prompt_for(run: str) -> str:",
        '    return "Keep the Baseline words out."',
        "",
        "class Digest:",
        "    def note(self) -> None:",
        '        self.logger.warning("no Baseline for %s", self)',
        '        logging.info("no Baseline for %s", self)',
        '        self.log.error("the Baseline is late")',
        '        print("skipped the Baseline", file=sys.stderr)',
        '        warnings.warn("the Baseline is gone")',
        '        self.log("Moved in the Baseline")',
        '        print("Printed from the Baseline")',
        "",
        "    def log(self, line: str) -> None:",
        "        self.lines.append(line)",
        "",
        "def signature() -> str:",
        '    return "Signed in the Baseline"',
        "",
        "def intro(run: str) -> str:",
        '    return f"Explain the Baseline of {run}."',
        "",
        "def brief(run: str) -> str:",
        '    return "Sum up the Baseline."',
        "",
        "async def ask(db, run: str) -> str:",
        "    system = intro(run)",
        '    answer = await gateway.complete(db, system, [{"role": "user", "content": brief(run) + lines.facts()}], 400, job="digest", model=chat_model())',
        "    return answer.text",
        "",
        "def chat_model() -> str:",
        '    return "Chosen in the Baseline"',
        "",
        "def welcome() -> str:",
        '    return "Welcome to the Baseline"',
        "",
        "async def greet(db, to: str) -> EmailMessage:",
        '    await gateway.complete(db, welcome(), [], 100, job="digest")',
        "    msg = EmailMessage()",
        "    msg.set_content(welcome())",
        "    return msg",
      ].join("\n"),
    ],
    ["digest/lines.py", 'EMPTY = "Nothing moved in the Baseline"\nKEY = "baseline"\ndef facts() -> str:\n    return "Mind the Baseline."'],
    ["digest/store.py", 'NOTE = "Kept in the Baseline"'],
    ["digest/prompts.py", 'SYSTEM = "<p>Read the Baseline.</p>"'],
    [
      "slack/weekly.py",
      [
        "from . import footer",
        "from .blocks import header",
        "from oracle.roadmap.words import label",
        "from oracle import settings",
        "from oracle.runs.tasks import DIGEST",
        "def post(c):",
        '    c.chat_postMessage(blocks=[{"type": "mrkdwn", "text": f"*{c.name}* moved in the Baseline"}])',
      ].join("\n"),
    ],
    ["slack/blocks.py", 'HEADER = "Moved in the Baseline"'],
    ["slack/footer.py", 'TEXT = "Posted from the Baseline"'],
    ["roadmap/words.py", 'def label() -> str:\n    return "Planned in the Baseline"'],
    ["roadmap/store.py", 'NOTE = "Stored in the Baseline"'],
    ["runs/tasks.py", 'DIGEST_TASK = "Sum up the week."\nDIGEST = Segment(task="Read the graph and write the digest.", title="Baseline to digest")'],
    ["settings.py", 'NAME = "Set in the Baseline"'],
  ]);
  expect(shownModules(planted)).toEqual(["digest/email.py", "digest/lines.py", "roadmap/words.py", "runs/tasks.py", "slack/blocks.py", "slack/footer.py", "slack/weekly.py"]);
  const fed = promptBuilders(planted);
  expect(shownModules(planted).flatMap((rel) => pythonOldNames(rel, planted.get(rel)!, fed.get(rel)))).toEqual([
    "digest/email.py:8: Hi {}, read what changed in the Baseline.",
    "digest/email.py:18: Sent from the Baseline",
    "digest/email.py:33: Moved in the Baseline",
    "digest/email.py:34: Printed from the Baseline",
    "digest/email.py:40: Signed in the Baseline",
    "digest/email.py:54: Chosen in the Baseline",
    "digest/email.py:57: Welcome to the Baseline",
    "digest/lines.py:1: Nothing moved in the Baseline",
    "roadmap/words.py:2: Planned in the Baseline",
    "runs/tasks.py:2: Baseline to digest",
    "slack/blocks.py:1: Moved in the Baseline",
    "slack/footer.py:1: Posted from the Baseline",
    "slack/weekly.py:7: *{}* moved in the Baseline",
  ]);
  // fails_when = a function whose returned text goes to the model (by a variable, inside the call, or
  // from a module it imports) is not found as a prompt builder, or one that only picks the model, or
  // whose text also goes into an email (welcome), is.
  expect(Object.fromEntries([...fed].map(([rel, names]) => [rel, [...names].sort()]))).toEqual({
    "digest/email.py": ["brief", "intro"],
    "digest/lines.py": ["facts"],
  });
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
