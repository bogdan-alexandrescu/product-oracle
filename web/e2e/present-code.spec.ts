import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// PR 1300 review round 3, owner decision (Nov 5): code stays out of decks. In Present mode a
// code block is one line on its slide, "Code: 40 lines, in the full PRD", a link to that
// place in the full PRD; it is never cut into continuation slides, and no slide is blank
// (the mock's "long-code" scenario: saved-carts v2's Problem holds a 40-line code block).

const SLIDE = "/documents/saved-carts/v/2/present";
const current = (page: Page) => page.getByTestId("audience-view").locator(".current-slide");

test.use({ viewport: { width: 1440, height: 900 } });

test("a code block is one line linking to the full PRD, never blank slides", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "long-code"), [MOCK_SCENARIO_KEY] as const);
  await login(page);
  await page.goto(SLIDE);
  const counter = page.getByTestId("slide-counter");
  await expect(counter).toHaveText(/^1 \/ \d+$/);
  const total = Number((await counter.innerText()).split("/")[1]);
  const headings: string[] = [];
  for (let n = 2; n <= total; n++) {
    await page.getByRole("button", { name: "Next slide" }).click();
    await expect(counter).toHaveText(`${n} / ${total}`);
    const slide = current(page);
    const heading = await slide.locator(".slide-title").innerText();
    headings.push(heading);
    const body = slide.locator(".slide-body");
    if ((await body.count()) === 0) continue;
    // No slide is blank, none shows the code itself.
    expect((await body.innerText()).trim(), heading).not.toBe("");
    expect(await body.innerText()).not.toContain("step 7 of the rollout");
  }
  expect(headings.filter((h) => h.startsWith("Problem"))).toEqual(["Problem"]);

  await page.goto(`${SLIDE}?slide=${headings.indexOf("Problem") + 2}`);
  const slide = current(page);
  await expect(slide.locator(".slide-title")).toHaveText("Problem");
  await expect(slide.locator(".slide-body")).toContainText("Steps to try:");
  const link = slide.getByRole("link", { name: "Code: 40 lines, in the full PRD" });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", /\/documents\/saved-carts\/v\/2#s-problem$/);
  await link.click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2#s-problem$/);
  await expect(page.locator("#s-problem")).toBeVisible();
});
