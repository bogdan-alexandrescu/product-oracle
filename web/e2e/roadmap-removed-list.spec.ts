import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * removed-tracks, the owner's pick 'Removed list, panel says who' (ec2 C): "Removed · N" at the
 * start of the Roadmap's filter row opens one list of everything removed from the plans (cut
 * features, archived goals, removed goal milestones) with who and when, each with Restore; an
 * approver who does not decide proposes it to the decider; a viewer reads. A cut feature opened
 * from the list says who cut it and when. Invented people and products (the mock's seed).
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
  test("an owner restores a cut feature, an archived goal and a removed milestone, each with Undo", async ({ page }) => {
    await open(page);
    await shot(page, "ec2-c-rest");
    await expect(button(page)).toHaveText("Removed · 3");
    await button(page).click();
    await expect(list(page).getByText("Removed from your plans")).toBeVisible();
    await expect(row(page, "In-app tour")).toContainText(/Feature · Onboarding roadmap · Cut on [A-Z][a-z]{2} \d+ by /);
    await expect(row(page, "Fewer support tickets about billing")).toContainText(/Goal · Goals · Archived on [A-Z][a-z]{2} \d+ by /);
    await expect(row(page, "Private beta for 20 teams")).toContainText(/Milestone · Grow retention · Removed on [A-Z][a-z]{2} \d+ by /);
    await shot(page, "ec2-c-open");

    // The cut feature opens its panel, which says who cut it and when (and no Restore link).
    await row(page, "In-app tour").getByRole("button", { name: "In-app tour" }).click();
    const panel = page.getByTestId("feature-panel");
    await expect(panel.getByTestId("fp-cut-by")).toHaveText(/^Cut on [A-Z][a-z]{2} \d+ by .+/);
    await expect(panel.getByRole("button", { name: /^Restore/ })).toHaveCount(0);
    await shot(page, "ec2-c-mid");
    await page.keyboard.press("Escape");

    await button(page).click();
    await row(page, "In-app tour").getByRole("button", { name: "Restore" }).click();
    await expect(list(page)).toBeHidden();
    await expect(button(page)).toHaveText("Removed · 2");
    const toasts = page.getByTestId("toasts");
    await expect(toasts).toContainText("Restored In-app tour");
    await shot(page, "ec2-c-result");
    await toasts.getByRole("button", { name: "Undo" }).click();
    await expect(button(page)).toHaveText("Removed · 3");

    await button(page).click();
    await row(page, "Fewer support tickets about billing").getByRole("button", { name: "Restore" }).click();
    await expect(toasts).toContainText("Restored Fewer support tickets about billing");
    await expect(button(page)).toHaveText("Removed · 2");
    await button(page).click();
    await row(page, "Private beta for 20 teams").getByRole("button", { name: "Restore" }).click();
    await expect(toasts).toContainText("Restored Private beta for 20 teams");
    await expect(button(page)).toHaveText("Removed · 1");
    await button(page).click();
    await expect(list(page).getByTestId("removed-row")).toHaveCount(1);
    await expect(list(page)).not.toContainText("Trash is empty");
  });

  test("an approver who does not decide proposes restoring, naming the decider", async ({ page }) => {
    await open(page, "approver@example.com");
    await button(page).click();
    const r = row(page, "Fewer support tickets about billing");
    await expect(r.getByRole("button", { name: "Propose restoring" })).toBeVisible();
    await shot(page, "ec2-c-propose");
    await r.getByRole("button", { name: "Propose restoring" }).click();
    await expect(page.getByTestId("toasts")).toContainText("Restoring Fewer support tickets about billing proposed · waits for Avery Stone");
    await expect(button(page)).toHaveText("Removed · 3");
  });

  test("a viewer reads the list", async ({ page }) => {
    await open(page, "viewer@example.com");
    await button(page).click();
    await expect(list(page).getByTestId("removed-row")).toHaveCount(3);
    await expect(list(page).getByRole("button", { name: /Restore|Propose restoring/ })).toHaveCount(0);
    await shot(page, "ec2-c-readonly");
  });

  test.describe("on a phone", () => {
    test.use(PHONE);
    test("the list opens under its button and restores", async ({ page }) => {
      await open(page);
      await button(page).click();
      await expect(row(page, "In-app tour")).toBeVisible();
      // A byline never splits inside a person's name.
      const by = row(page, "Private beta for 20 teams").locator("span.inline-block");
      expect((await by.boundingBox())!.height).toBeLessThan(24);
      await shot(page, "ec2-c-open-phone");
      await row(page, "Private beta for 20 teams").getByRole("button", { name: "Restore" }).click();
      await expect(button(page)).toHaveText("Removed · 2");
    });
  });
});
