import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * removed-tracks, the owner's pick 'Removed list, panel says who' (ec2 C): "Removed · N" at the
 * start of the Roadmap's filter row opens one list of everything removed from the plans (cut
 * features, archived goals, removed goal milestones) with who and when, each with Restore; who
 * does not decide proposes it to the decider; a viewer reads. A cut feature opened from the list
 * says who cut it and when. Invented people and products (the mock's seed).
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const SHOTS = process.env.RT_COMPARE_DIR;
const SCHEME: "light" | "dark" = process.env.RT_SCHEME === "dark" ? "dark" : "light";

async function open(page: Page, email?: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, SCHEME] as const);
  await page.emulateMedia({ colorScheme: SCHEME });
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}${SCHEME === "dark" ? "-dark" : ""}.png` });
};
const button = (page: Page) => page.getByTestId("removed-open");
const list = (page: Page) => page.getByRole("dialog", { name: "Removed from your plans" });
const row = (page: Page, title: string) => list(page).getByTestId("removed-row").filter({ hasText: title });

test.describe("Removed list", () => {
  test("an owner restores a cut feature, an archived goal and a removed milestone; the feature's Undo puts it back", async ({ page }) => {
    test.setTimeout(90_000);
    await open(page);
    await shot(page, "ec2-c-rest");
    // The seed's cut feature, removed milestone and four archived goals (three archived before who was kept).
    await expect(button(page)).toHaveText("Removed · 6");
    await button(page).click();
    await expect(list(page).getByText("Removed from your plans")).toBeVisible();
    await expect(row(page, "In-app tour")).toContainText(/Feature · Onboarding roadmap · Cut on [A-Z][a-z]{2} \d+ by /);
    await expect(row(page, "Fewer support tickets about billing")).toContainText(/Goal · Goals · Archived on [A-Z][a-z]{2} \d+ by /);
    await expect(row(page, "Private beta for 20 teams")).toContainText(/Milestone · Grow retention · Removed on [A-Z][a-z]{2} \d+ by /);
    await shot(page, "ec2-c-open");

    // The cut feature opens its panel, which says who cut it and when.
    await row(page, "In-app tour").getByRole("button", { name: "In-app tour" }).click();
    const panel = page.getByRole("dialog", { name: "In-app tour" });
    await expect(panel.getByTestId("item-cut")).toHaveText(/^Cut on [A-Z][a-z]{2} \d+ by .+/);
    await shot(page, "ec2-c-mid");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await button(page).click();
    await row(page, "In-app tour").getByRole("button", { name: "Restore" }).click();
    await expect(list(page)).toBeHidden();
    await expect(button(page)).toHaveText("Removed · 5");
    const toasts = page.getByTestId("toasts");
    await expect(toasts).toContainText("Restored In-app tour");
    await shot(page, "ec2-c-result");
    await toasts.getByRole("button", { name: "Undo" }).click();
    await expect(button(page)).toHaveText("Removed · 6");

    await button(page).click();
    await row(page, "Fewer support tickets about billing").getByRole("button", { name: "Restore" }).click();
    await expect(toasts).toContainText("Restored Fewer support tickets about billing");
    await expect(button(page)).toHaveText("Removed · 5");
    await button(page).click();
    await row(page, "Private beta for 20 teams").getByRole("button", { name: "Restore" }).click();
    await expect(toasts).toContainText("Restored Private beta for 20 teams");
    await expect(button(page)).toHaveText("Removed · 4");
    await button(page).click();
    await expect(list(page).getByTestId("removed-row")).toHaveCount(4);
    // An archived goal whose archiver is not known reads its day alone.
    await expect(row(page, "Faster first report").locator("span.inline-block")).toHaveText(/^Archived on [A-Z][a-z]{2} \d+$/);
  });

  test("an approver restores an archived goal and proposes restoring what another decides, naming the decider", async ({ page }) => {
    await open(page, "approver@example.com");
    await button(page).click();
    // An approver puts an archived goal back at once (as the goal's own Restore does).
    await expect(row(page, "Fewer support tickets about billing").getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    const r = row(page, "Private beta for 20 teams");
    await expect(r.getByRole("button", { name: "Propose restoring" })).toBeVisible();
    await shot(page, "ec2-c-propose");
    await r.getByRole("button", { name: "Propose restoring" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Restoring Private beta for 20 teams proposed · waits for Avery Stone");
    await expect(button(page)).toHaveText("Removed · 6");
  });

  test("a viewer reads the list", async ({ page }) => {
    await open(page, "viewer@example.com");
    await button(page).click();
    await expect(list(page).getByTestId("removed-row")).toHaveCount(6);
    await expect(list(page).getByRole("button", { name: /Restore|Propose restoring/ })).toHaveCount(0);
    await shot(page, "ec2-c-readonly");
  });

  test.describe("on a phone", () => {
    test.use(PHONE);
    test("the list opens under its button and restores", async ({ page }) => {
      await open(page);
      await button(page).click();
      await expect(row(page, "In-app tour")).toBeVisible();
      // The list fits the phone's width.
      const box = (await list(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      // A byline never splits inside a person's name.
      const by = row(page, "Private beta for 20 teams").locator("span.inline-block");
      expect((await by.boundingBox())!.height).toBeLessThan(24);
      await shot(page, "ec2-c-open-phone");
      await row(page, "Private beta for 20 teams").getByRole("button", { name: "Restore" }).click();
      await expect(button(page)).toHaveText("Removed · 5");
    });
  });
});
