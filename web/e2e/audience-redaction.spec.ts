import { readFileSync } from "node:fs";
import path from "node:path";

import { redact } from "../lib/api/mock/audience";
import { expect, test } from "./test";

/**
 * #680 re-review: the mock hides what each audience hides in written item text exactly as
 * the API does. The cases are the API's own (api/tests/fixtures/audience_redaction.json,
 * run there by tests/test_audience_redaction.py): every GFM table form, owner labels with
 * qualifiers and emphasis, a short goal-less title dropping only its own entries, and
 * spacing, dashes and HTML tags kept. Board leaves the goal-less items out.
 */
type Case = {
  name: string;
  items: { title: string; tracker?: string[]; no_goal?: boolean }[];
  text: string;
  board: string;
  team: string;
  engineering: string;
};

const CASES: Case[] = JSON.parse(readFileSync(path.join(__dirname, "../../api/tests/fixtures/audience_redaction.json"), "utf8"));

for (const c of CASES) {
  test(`the mock redacts as the API: ${c.name}`, () => {
    const refs = c.items.flatMap((i) => i.tracker ?? []);
    const titles = c.items.map((i) => i.title);
    const dropped = c.items.filter((i) => i.no_goal).map((i) => i.title);
    expect(redact(c.text, "board", refs, dropped, titles)).toBe(c.board);
    expect(redact(c.text, "team", refs, [], titles)).toBe(c.team);
    expect(redact(c.text, "engineering", refs, [], titles)).toBe(c.engineering);
  });
}
