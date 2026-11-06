import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";

import { expect, test } from "./test";

/**
 * Owner's decision (Nov 5), the source side of ground-truth-words.spec.ts: no string a page
 * can show, in web/app or web/components, says "Desired state", "Current state" or "Baseline"
 * for the graph, including text that only shows in a form or an empty state the walk does not
 * open. Reads every string literal, template piece and JSX text (comments aside).
 * fails_when = a label such as "change it in Baseline" or "Detailed › Baseline" is left.
 *
 * What may still say baseline: an id by its shape (one lowercase word, or joined to "_ / . : -":
 * "baseline", "/baseline", "baseline-tab"), and a measure's starting value: "Baseline value",
 * "Baseline 12", "Success metric and baseline", and the "Baseline" field beside "Predicted" on a
 * decision's or an outcome's prediction.
 */

const WEB = path.resolve(__dirname, "..");

/** The old names as words of their own (an id joined to "_ / . : -" is not one). */
const OLD = /desired state|current state|(?<![\w/.:\-])baseline(?![\w/.:\-])/i;
/** A measure's starting value. */
const STARTING_VALUE = /baseline value|baseline ?[:=]? ?[-+]?\d|success metric and baseline/gi;
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

/** Every string a file holds that says an old name, as "file:line: text". */
function oldNames(file: string): string[] {
  const rel = path.relative(WEB, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    let said: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) said = n.text;
    else if (ts.isJsxText(n)) said = n.getText();
    if (said !== null && saysOld(rel, said)) {
      out.push(`${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${JSON.stringify(said.trim().slice(0, 120))}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

test("no string a page can show in web/app or web/components says Desired state, Current state or Baseline", () => {
  const found = ["app", "components"].flatMap((dir) => [...sources(path.join(WEB, dir))].flatMap(oldNames));
  expect(found).toEqual([]);
});

test("the check catches the old names and spares the ids and the starting values", () => {
  for (const said of ["in the order; change it in Baseline", "Detailed › Baseline", "Baseline", "Current state", "Desired state", "Build the baseline"]) {
    expect(saysOld("app/x.tsx", said), said).toBe(true);
  }
  for (const kept of ["baseline", "/baseline", "baseline-tab", "baseline_confirm", "Baseline value", "Baseline 12", "Success metric and baseline"]) {
    expect(saysOld("app/x.tsx", kept), kept).toBe(false);
  }
  expect(saysOld("app/plan/outcomes/page.tsx", "Baseline")).toBe(false);
});
