import { readFileSync } from "node:fs";
import path from "node:path";

import { prdOnePager } from "../lib/api/mock/simple-one-pager";
import { expect, test } from "./test";

/**
 * Contract: the mock's per-PRD one-pager (prdOnePager, a hand copy of the API's
 * one_pager.mapping and one_pager.extract over the fallback blocks) reads a PRD as the API
 * does. api/tests/test_one_pager_contract.py parses the invented PRD in
 * api/tests/fixtures/one_pager_contract.md as an import does and writes the API's blocks,
 * with the parsed sections, to api/tests/fixtures/one_pager_contract.json; this spec runs the
 * mock over the same sections and compares, block for block and line for line (id, text,
 * source sections, whole text when cut, metric).
 *
 * protects = the mock's one-pager stays the API's; fails_when = either side changes how a
 * PRD's sections become one-pager lines and the other does not copy it.
 */
type Contract = {
  markdown: string;
  sections: { section_key: string; level: number; heading: string; body_md: string; body_text: string }[];
  blocks: {
    key: string;
    title: string;
    rules: string;
    kind: string;
    lines: { id: string; text: string; source_keys: string[]; full: string | null; metric: { name: string; from: string; to: string } | null }[];
  }[];
};

const FIXTURES = path.join(__dirname, "../../api/tests/fixtures");
const PRD = readFileSync(path.join(FIXTURES, "one_pager_contract.md"), "utf8");
const CONTRACT: Contract = JSON.parse(readFileSync(path.join(FIXTURES, "one_pager_contract.json"), "utf8"));

test("the contract was written from the shared PRD", () => {
  expect(CONTRACT.markdown).toBe(PRD);
});

test("the mock's one-pager for a PRD is the API's", () => {
  const db = prdOnePager({ id: "contract-prd", slug: "pantry-lists", title: "Pantry lists PRD" }, CONTRACT.sections);
  const blocks = db.blocks
    .filter((b) => b.kind !== "timeline")
    .map((b) => ({
      key: b.key,
      title: b.title,
      rules: b.rules,
      kind: b.kind,
      lines: b.lines.map((l) => ({ id: l.id, text: l.text, source_keys: l.keys, full: l.full ?? null, metric: l.metric ?? null })),
    }));
  expect(blocks).toEqual(CONTRACT.blocks);
});
