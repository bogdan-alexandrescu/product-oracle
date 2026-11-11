import { readFile } from "node:fs/promises";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * The one-pager reads cleanly for a PRD a run wrote (CLD's production pass, 2026-10-30), on
 * the mock's "one-pager-run-prd": a Goal-traced PRD whose lines carry [c:id] citations, read
 * before the one_pager job has written its page. Invented data.
 *
 * Test cards (protects / fails_when / no_claim):
 * - protects=the quick read shows no [c:...] token, whole or cut, on the page or in the PDF;
 *   one quiet line says Oracle is still writing the page; who has it is a sentence (the
 *   Primary's words), never "Primary; Job story; …"; an outcome whose definition is only
 *   citation ids says it has none (vqa one-pager 2: never a cited quote or title), one
 *   defined in the PRD's words shows them; a code named
 *   right after it in prose is not a "Needs a look" item, one followed by a lowercase word
 *   ("F-50 requires login") is; when the job did not write the page, one line says it is
 *   the quick read; fails_when=any of those reads as
 *   on production; no_claim=the API's reading (api/tests/test_simple_one_pager_run_prd.py).
 */
const URL = "/simple/one-pagers/guided-setup";
const WRITING = "Oracle is still writing this one-pager. Until then you see the PRD's own lines.";
const QUICK_READ = "Oracle has not written this one-pager yet. You see the PRD's own lines.";

async function open(page: Page, email?: string, scenario = "one-pager-run-prd") {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto(URL);
}

async function readsCleanly(page: Page) {
  await expect(page.getByTestId("one-pager-writing")).toHaveText(WRITING);
  const article = page.getByRole("article", { name: "One-pager" });
  const problem = article.getByRole("region", { name: "Problem and who has it" });
  await expect(problem).toContainText("finding new photos (about 9 minutes per day).");
  await expect(article).not.toContainText("[c");
  // Its whole text reads resolved too.
  await problem.getByRole("button", { name: "Show all" }).click();
  await expect(problem).toContainText("about 9 minutes per day). Every feature below serves sorting time:");
  await expect(article).not.toContainText("[c");
  // qa4-simple-prd-12 (#999): the problem's own words already name who has it, so no "Who has it"
  // line says it again.
  await expect(problem).toContainText("Owners of small photo libraries who add a few hundred photos a week");
  await expect(article.getByTestId("problem-who")).toHaveCount(0);
  const outcomes = article.getByRole("region", { name: "Outcomes and how we measure them" });
  // vqa one-pager 2: only the PRD's own words say how an outcome is counted; a definition that is only
  // citations is none (never the cited quote or its title), a source named only by its citation none.
  await expect(outcomes.locator('[data-line="outcomes-1"]').getByTestId("outcome-measure")).toHaveText("How it is measured is not in the PRD yet");
  await expect(outcomes.locator('[data-line="outcomes-2"]').getByTestId("outcome-measure")).toHaveText(
    "counted as: seconds from opening the library to opening the photo",
  );
  await expect(outcomes.locator('[data-line="outcomes-3"]').getByTestId("outcome-measure")).toHaveText("How it is measured is not in the PRD yet");
  await expect(article.getByRole("region", { name: "Not doing" })).toContainText("so F-11 Photo editing is out");
  // A lowercase word after a code is the sentence, never a name put beside the code.
  const risks = article.getByRole("region", { name: "Risks and open decisions" });
  await expect(risks).toContainText("F-50 requires login before albums show.");
  await expect(risks).not.toContainText("F-50 requires login requires");
  // Export PDF exports the same resolved words.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  const pdf = await readFile((await (await download).path())!, "utf8");
  expect(pdf).toContain("about 9 minutes per day).");
  expect(pdf).not.toContain("[c");
}

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 900 } });

    test("an owner reads a run's PRD cleanly while Oracle writes its one-pager", async ({ page }) => {
      await open(page);
      await readsCleanly(page);
      const look = page.getByRole("region", { name: "Needs a look" });
      // qa4-simple-prd-11 (#999): each names the page's own section, not the PRD's heading.
      await expect(look.getByTestId("needs-look-line")).toHaveText(["F-40 has no name in “Risks and open decisions”", "F-50 has no name in “Risks and open decisions”"]);
      // C-15: a code reads as the numbers do, one short line with the detail behind an (i).
      await expect(look.getByRole("button", { name: "About F-40 has no name in “Risks and open decisions”" })).toHaveAccessibleDescription(/F-40 has no name in the PRD\./);
      await expect(look.getByTestId("needs-look-go")).toHaveText(["In: Risks and open decisions", "In: Risks and open decisions"]);
      // C-15: each line opens the PRD at its section to fix it.
      await expect(look.getByRole("link", { name: "Open the section" })).toHaveCount(2);
      await expect(look.getByRole("link", { name: "Open the section" }).first()).toHaveAttribute("href", /^\/documents\/[^#/]+\/v\/\d+#top-risks$/);
    });

    test("when Oracle's job did not write the page, one line says it is the quick read", async ({ page }) => {
      await open(page, "viewer@example.com", "one-pager-quick-read");
      await expect(page.getByTestId("one-pager-quick-read")).toHaveText(QUICK_READ);
      await expect(page.getByTestId("one-pager-writing")).toHaveCount(0);
      await expect(page.getByRole("article", { name: "One-pager" })).not.toContainText("[c");
    });

    test("a viewer reads the same clean page, with no Needs a look", async ({ page }) => {
      await open(page, "viewer@example.com");
      await readsCleanly(page);
      await expect(page.getByRole("region", { name: "Needs a look" })).toHaveCount(0);
    });
  });
}
