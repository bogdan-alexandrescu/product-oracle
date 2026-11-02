import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openSection } from "./helpers";

// walk-docs-priorities 8-10: a PRD's version page and Publish, driven as a person on the mock.
// Saved carts v2 is a draft whose "Decisions needed" names its days in ISO; the "next-draft"
// scenario's fleet PRD (v2) has accepted changes staged for draft 3. Invented data only.

const CARTS = "/documents/saved-carts/v/2";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openVersion(page: Page, url: string) {
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("document-sections")).toBeVisible();
}

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(name, () => {
    test.use({ viewport });

    test("walk-docs-priorities 9: a PRD's body reads its dates month first", async ({ page }) => {
      await openVersion(page, CARTS);
      const decisions = await openSection(page, "decisions");
      // What a person sees (innerText): the ISO day stays only in a hidden node the comment anchors count.
      const shown = () => decisions.innerText();
      await expect.poll(shown).toContain("needed by Nov 1, 2026.");
      await expect.poll(shown).toContain("needed by Nov 15, 2026.");
      expect(await shown()).not.toContain("2026-11-01");
    });

    test("walk-docs-priorities 10: Publish lists the accepted changes staged for the next draft", async ({ page }) => {
      await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, "next-draft"] as const);
      await login(page);
      await page.goto("/documents/fleet-next/publish");
      const staged = page.getByRole("region", { name: "Staged for the next draft" });
      await expect(staged).toBeVisible();
      await expect(staged.getByTestId("staged-note")).toHaveText("Not in version 2: they go into draft 3");
      await expect(staged.getByTestId("publish-staged-item")).toHaveCount(3);
      await expect(staged.getByTestId("publish-staged-item").first()).toContainText("F-33 Proof of delivery");
      await expect(staged).toContainText("The draft never says how drivers learn the new app.");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("walk-docs-priorities 8: the header's status is one status, kept live on a page left open", async ({ page, context }) => {
    test.setTimeout(60_000);
    await openVersion(page, CARTS);
    await expect(page.getByTestId("doc-status")).toHaveText("Draft");

    // Someone else, in another tab, approves a section: the PRD is now in review.
    const other = await context.newPage();
    await other.goto(CARTS);
    const bar = (await openSection(other, "summary")).getByTestId("review-bar");
    await bar.getByRole("group", { name: "Verdict for Summary" }).getByRole("button", { name: "Approve" }).click();
    await bar.getByTestId("verdict-submit").click();
    await expect(bar.getByTestId("verdict-state")).toContainText("Approved");
    await expect(other.getByTestId("doc-status")).toHaveText("In review");

    // The first page, never reloaded nor focused again, says the same.
    await expect(page.getByTestId("doc-status")).toHaveText("In review", { timeout: 25_000 });
  });
});
