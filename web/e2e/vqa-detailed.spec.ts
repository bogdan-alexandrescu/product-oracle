import { expect, test } from "./test";

import { login } from "./helpers";

/*
 * Visual QA of the picked Detailed screens as merged (train AH), each check driven as a person
 * would on the mock:
 * - QD1 a: on a phone the Held rewrites drawer rises almost to the top, however few rewrites it
 *   holds; a card shows its own reason only, the drawer's intro says the rest once.
 * - QD2 a: on a phone, Re-plan… in a plan item's sheet opens the priced dialog above the sheet,
 *   so its Cancel and Start for $N can be pressed.
 */

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("QD1 a: the Held rewrites drawer rises almost to the top on a phone", async ({ page }) => {
    // protects=the phone drawer's height; fails_when=it shrinks to one short rewrite and leaves
    // the page's toolbar showing above it; no_claim=its look on a desktop.
    await login(page);
    await page.goto("/documents/checkout-redesign/v/2");
    await page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).click();
    const drawer = page.getByRole("dialog", { name: "Held rewrites" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("held-rewrite")).toHaveCount(1);
    const box = (await drawer.boundingBox())!;
    expect(box.height).toBeGreaterThan(844 * 0.8);
  });

  test("QD2 a: Re-plan… in a plan item's sheet opens its dialog above the sheet", async ({ page }) => {
    // protects=the priced dialog is drawn above the item sheet; fails_when=the sheet covers its
    // price, Cancel and Start; no_claim=the price itself.
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "track-alerts"));
    await login(page);
    await page.goto("/plan");
    await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Daily alert digest" }).getByTestId("plan-title").click();
    await page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-alert").getByRole("button", { name: "Re-plan…" }).click();
    const dialog = page.getByRole("dialog", { name: "Re-plan this track" });
    await expect(dialog.getByRole("button", { name: /^Start for \$/ })).toBeVisible();
    await expect(dialog.getByTestId("estimate-total")).toBeVisible();
    // The item sheet stays open under it (it takes no taps then, so ask what is drawn on top).
    const sheetZ = await page.getByTestId("sheet-scrim").first().evaluate((el) => Number(getComputedStyle(el.parentElement!).zIndex));
    const dialogZ = await page.getByTestId("dialog-backdrop").filter({ has: dialog }).evaluate((el) => Number(getComputedStyle(el).zIndex));
    expect(dialogZ).toBeGreaterThan(sheetZ);
    await dialog.getByRole("button", { name: "Cancel" }).click({ timeout: 5000 });
    await expect(dialog).toBeHidden();
  });
});

test("QD1 a: a held rewrite's card does not repeat the drawer's intro", async ({ page }) => {
  // protects=the stock reason is said once, in the intro; fails_when=every card repeats "An
  // agent draft rewrote this approved section…"; no_claim=a rewrite with its own reason.
  await login(page);
  await page.goto("/documents/checkout-redesign/v/2");
  await page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).click();
  const drawer = page.getByRole("dialog", { name: "Held rewrites" });
  await expect(drawer.getByTestId("held-intro")).toContainText("The approved text was kept until someone decides.");
  await expect(drawer.getByTestId("held-rewrite")).toContainText("Goal trace");
  await expect(drawer.getByTestId("held-rewrite")).not.toContainText("Review the rewrite as a diff");
});

for (const [where, use] of [
  ["desktop", { viewport: { width: 1440, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
] as const) {
  test.describe(where, () => {
    test.use(use);

    test(`roadmap key dates: a name keeps its words whole beside Edit and Remove (${where})`, async ({ page }) => {
      // protects=a key date's name reads as words; fails_when=its day, badge and buttons squeeze
      // it to a letter or two a line ("conferenc" / "e"); no_claim=the dates themselves.
      await login(page);
      await page.goto("/simple/roadmap?roadmap=alerts-roadmap");
      await page.getByTestId("key-dates-open").click();
      const row = page.getByTestId("key-dates-editor").locator('[data-testid="key-date-row"][data-name="Customer conference"]');
      await expect(row.getByRole("button", { name: "Edit Customer conference" })).toBeVisible();
      const lines = await row.getByTitle("Customer conference").evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return new Set([...r.getClientRects()].map((b) => Math.round(b.top))).size;
      });
      expect(lines).toBe(1);
      const day = (await row.getByTestId("key-date-day").boundingBox())!;
      const name = (await row.getByTitle("Customer conference").boundingBox())!;
      expect(Math.abs(day.y - name.y)).toBeLessThanOrEqual(1);
    });
  });
}
