import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Train U follow-up 6 (#723): every mock PRD has its own one-pager state
 * (./lib/api/mock/server.ts), driven through the UI as an owner on desktop and phone, light
 * and dark.
 *
 * Card one-pager-per-prd: protects = a line edited on one PRD's one-pager (the invented
 * page every mock PRD is served) shows on that PRD's page only: the seeded PRD's line stays
 * published while another PRD's is edited, and each keeps its own wording and working-draft
 * count after both are edited, and the other PRD's one-pager opened by its document id (a
 * link that carries the id) is that PRD's, with its edit;
 * fails_when = the mock serves every PRD one shared working draft, so an edit made on one
 * PRD's one-pager shows on another's, or finds a one-pager by slug only; no_claim = the API
 * (one working draft per roadmap, api/tests/test_simple_one_pager_api.py) and Remind's
 * per-PRD reviewers.
 */

const SEEDED = "/simple/prds/guided-setup";
const OTHER = "/simple/one-pagers/checkout-redesign";
const LINE_2 = "A setup checklist that shows the next step";

async function editLine2(page: Page, text: string) {
  await page.getByRole("button", { name: "Edit “A setup checklist that shows" }).click();
  await page.getByLabel("New wording for").fill(text);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-line="bets-1"]')).toHaveAttribute("data-state", "edited");
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1366, height: 820 }, colorScheme: scheme });

      test("a line edit on one PRD's one-pager shows on that PRD only", async ({ page }) => {
        await login(page);
        await page.goto(OTHER);
        await expect(page.getByRole("heading", { level: 1, name: "Checkout redesign PRD" })).toBeVisible();
        // The PRD's document id, read (never written) from the mock's saved state: a link that carries it.
        const otherId = await page.evaluate(() => {
          const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!) as { documents: { id: string; slug: string }[] };
          return db.documents.find((d) => d.slug === "checkout-redesign")!.id;
        });
        await editLine2(page, "A checkout checklist with saved cards");

        await page.goto(SEEDED);
        await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
        const line = page.locator('[data-line="bets-1"]');
        await expect(line).toHaveAttribute("data-state", "published");
        await expect(line).toContainText(LINE_2);
        await expect(page.getByRole("status", { name: "Working draft" })).toHaveCount(0);
        await editLine2(page, "A setup checklist with the next two steps");
        await expect(line).not.toContainText("saved cards");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");

        await page.goto(OTHER);
        await expect(page.getByRole("heading", { level: 1, name: "Checkout redesign PRD" })).toBeVisible();
        await expect(line).toContainText("A checkout checklist with saved cards");
        await expect(line).not.toContainText("next two steps");
        await expect(page.getByRole("status", { name: "Working draft" })).toContainText("1 change");

        await page.goto(`/simple/one-pagers/${otherId}`);
        await expect(page.getByRole("heading", { level: 1, name: "Checkout redesign PRD" })).toBeVisible();
        await expect(line).toContainText("A checkout checklist with saved cards");
      });
    });
  }
}
