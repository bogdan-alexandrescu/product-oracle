import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Pre-demo QA on Simple's One-pagers, driven through the UI as an owner and a viewer, on
 * desktop (1440) and phone (390), light and dark.
 *
 * Card simple-one-pagers-qa: protects = S-8, the Usage alerts PRD's one-pager Timeline lists
 * the roadmap's Usage alerts items (one_pager.prd_items), not "No roadmap items yet"; P-9, a
 * block with nothing from the PRD says "Not in the PRD yet" once (not again for who has the
 * problem, nor for each older line that only says it); P-5, a goal code reads with its name
 * beside it ("G2 Retention"), never "G2 (retention)"; S-9, Export PDF says the download is
 * starting and done, and says plainly when the API cannot make the PDF (its 503); V-8, the
 * One-pagers help line offers a viewer neither a wording change nor a review;
 * fails_when = the Timeline counts only the PRD's own slice, the mark repeats, a code shows
 * bare or bracketed, a failed export says nothing clear, or a viewer is told to change words;
 * no_claim = the API's reads (api/tests/test_simple_one_pager_qa.py).
 */

async function scenario(page: Page, name: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("the Usage alerts one-pager lists its roadmap items and says 'Not in the PRD yet' once a section", async ({ page }) => {
        await login(page);
        await page.goto("/simple/one-pagers");
        await page.getByTestId("simple-one-pagers").getByRole("link", { name: /Usage alerts PRD/ }).first().click();
        await expect(page.getByRole("heading", { level: 1, name: "Usage alerts PRD" })).toBeVisible();
        const pager = page.getByTestId("one-pager");
        await expect(pager.getByText("No roadmap items yet")).toHaveCount(0);
        await expect(pager.getByText("Weekly alert digest").first()).toBeVisible();
        await expect(pager.getByText("Alert rules engine").first()).toBeVisible();
        const problem = page.getByRole("region", { name: "Problem and who has it" });
        await expect(problem.getByText(/not in the PRD yet/i)).toHaveCount(1);
        for (const name of ["What we will build", "Not doing", "Risks and open decisions"]) {
          await expect(page.getByRole("region", { name }).getByText(/not in the PRD yet/i)).toHaveCount(1);
        }
      });

      test("an older build's lines that only say 'Not in the PRD yet' read it once", async ({ page }) => {
        await scenario(page, "one-pager-not-in-prd");
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        const risks = page.getByRole("region", { name: "Risks and open decisions" });
        await expect(risks.getByTestId("one-pager-empty-block")).toHaveText("Not in the PRD yet");
        await expect(risks.getByText(/not in the PRD yet/i)).toHaveCount(1);
      });

      test("a goal code reads with its name beside it", async ({ page }) => {
        await login(page);
        await page.goto("/simple/one-pagers/saved-carts");
        const outcomes = page.getByRole("region", { name: "Outcomes and how we measure them" });
        await expect(outcomes.getByText("G2 Retention: more repeat orders within 30 days.")).toBeVisible();
        await expect(outcomes.getByText("G2 (retention)")).toHaveCount(0);
      });

      test("Export PDF says the download started and finished", async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export PDF" }).click();
        await download;
        await expect(page.getByRole("status").filter({ hasText: "PDF downloaded" })).toBeVisible();
      });

      test("Export PDF says plainly when the PDF cannot be made", async ({ page }) => {
        await scenario(page, "one-pager-pdf-down");
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        await page.getByRole("button", { name: "Export PDF" }).click();
        const alert = page.getByRole("alert").filter({ hasText: "The PDF did not download" });
        await expect(alert).toHaveText("The PDF did not download: PDF export is not available right now. Try again later.");
        await expect(alert).not.toContainText("WeasyPrint");
        await expect(page.getByRole("button", { name: "Export PDF" })).toBeEnabled();
      });

      for (const [who, email, lead] of [
        ["owner", undefined, "Open a PRD to read it on one page, change its wording or start a review."],
        ["viewer", "viewer@example.com", "Open a PRD to read it on one page."],
      ] as const) {
        test(`the One-pagers help line offers ${who === "owner" ? "an" : "a"} ${who} only what they can do`, async ({ page }) => {
          await login(page, email);
          await page.goto("/simple/one-pagers");
          await expect(page.getByText(lead, { exact: true })).toBeVisible();
          if (who === "viewer") await expect(page.getByText(/change its wording|start a review/)).toHaveCount(0);
        });
      }
    });
  }
}
