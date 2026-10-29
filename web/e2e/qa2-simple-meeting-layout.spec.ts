import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * QA pass 2, simple-decide lane: the live meeting screen's layout, driven through the UI on
 * the mock's invented data.
 *
 * protects = qa-simple-decide-39 (the meeting's select drawn as Decisions' filters), -40 (End
 * as tall as the header's other buttons; the header does not shift between steps), -42 (a
 * change applied in the chat shows at once in All decisions; the stage note says it covers
 * one-pager edits), -48 (on a phone the header scrolls away and its targets are 44 px).
 */

const chat = (page: Page) => page.getByTestId("meeting-chat");
const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function startReview(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = page.getByRole("dialog", { name: "Start a review" });
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await s.getByRole("checkbox", { name: "Commenter" }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a styled rules select, a steady header, and a chat change shown at once", async ({ page }) => {
    await startReview(page);
    const select = page.getByRole("combobox", { name: "Who changes things" });
    await expect(select).toHaveClass(/simple-select/);
    const end = page.getByRole("button", { name: "End meeting" });
    expect((await end.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    const before = (await end.boundingBox())!;
    await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
    await expect(page.getByRole("region", { name: "Roadmap slice" })).toBeVisible();
    const after = (await end.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    await steps(page).getByRole("button", { name: "1 One-pager" }).click();

    await expect(page.getByRole("region", { name: "Stage" })).toContainText("No edits to this one-pager yet.");
    const box = chat(page);
    await box.getByRole("textbox", { name: "Message Oracle" }).fill("push Team invite nudges to next quarter and make Commenter own it");
    await tap(box.getByRole("button", { name: "Send" }));
    await tap(box.getByRole("button", { name: "Apply all" }));
    // No reload: All decisions lists what the chat changed.
    await expect(page.getByRole("region", { name: "All decisions" }).getByTestId("meeting-decision").first()).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the header scrolls away and its targets are 44 px", async ({ page }) => {
    await startReview(page);
    const header = page.getByRole("banner", { name: "Meeting" }).or(page.locator('header[aria-label="Meeting"]')).first();
    expect(await header.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    const step = steps(page).getByRole("button", { name: "2 Roadmap" });
    expect((await step.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const chip = page.getByLabel("Attendees").locator("li").first();
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});
