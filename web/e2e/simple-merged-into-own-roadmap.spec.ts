import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * A merged feature names the kept feature of its own roadmap (#1407 review). Test card: protects =
 * when another roadmap holds an item with the same key as the kept one, the merged feature's card
 * on the board still reads "Merged into <its own roadmap's kept feature>", as the API finds the kept
 * item by (roadmap id, key); fails_when = it names the other roadmap's item; no_claim = the API's
 * read. Mock API, made-up data: the Onboarding roadmap is given an item "Mobile setup tips" under
 * the same key as the Alerts roadmap's "Mobile alert push".
 */

const boardCard = (page: Page, key: string) => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/**
 * Alert routing by team merged into Mobile alert push, and another roadmap's item under the kept
 * item's key, read before it (first in the list). The mock's own Merge action finds its target by
 * key alone too, so the merge is given as stored data.
 */
async function giveSameKeyElsewhere(page: Page) {
  await page.evaluate(() => {
    const db = JSON.parse(localStorage.getItem("po-mock-db-v2")!);
    db.simple_roadmap.items.find((s: { key: string }) => s.key === "alert-sso").merged_into = "alert-mobile";
    db.simple_roadmap.items.unshift({ key: "alert-mobile", title: "Mobile setup tips", horizon: "later", roadmap: "onboarding-roadmap" });
    localStorage.setItem("po-mock-db-v2", JSON.stringify(db));
  });
}

test("a merged feature names the kept feature of its own roadmap, not another's with the same key", async ({ page }) => {
  await login(page);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await giveSameKeyElsewhere(page);

  await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await tap(page.getByTestId("format-board"));
  await expect(page.getByTestId("board")).toBeVisible();
  const merged = boardCard(page, "alert-sso").getByTestId("item-merged");
  await expect(merged).toHaveText(/^Merged into (\S+ )?Mobile alert push$/);
  await expect(merged).not.toContainText("Mobile setup tips");
});
