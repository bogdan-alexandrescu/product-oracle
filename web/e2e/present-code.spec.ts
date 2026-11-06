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

// Round 3, again: every code block is found as CommonMark finds it (the mock's "code-kinds"
// scenario): an indented block, a four-backtick fence holding a ``` line and a one-line fence
// are each one line; an empty fence shows nothing; the line is never part of a paragraph.
test("every kind of code block is one line, an empty one none", async ({ page }) => {
  await page.addInitScript(([key]) => localStorage.setItem(key, "code-kinds"), [MOCK_SCENARIO_KEY] as const);
  await login(page);
  await page.goto(SLIDE);
  const counter = page.getByTestId("slide-counter");
  await expect(counter).toHaveText(/^1 \/ \d+$/);
  const total = Number((await counter.innerText()).split("/")[1]);
  let problem = 0;
  for (let n = 2; n <= total; n++) {
    await page.getByRole("button", { name: "Next slide" }).click();
    await expect(counter).toHaveText(`${n} / ${total}`);
    const title = await current(page).locator(".slide-title").innerText();
    expect(title).not.toMatch(/^Problem \(/);
    if (title === "Problem") problem = n;
  }
  expect(problem).toBeGreaterThan(0);
  await page.goto(`${SLIDE}?slide=${problem}`);
  const body = current(page).locator(".slide-body");
  await expect(body).toContainText("After the steps.");
  const links = body.getByRole("link", { name: /^Code: \d+ lines?, in the full PRD$/ });
  await expect(links).toHaveText([
    "Code: 40 lines, in the full PRD",
    "Code: 2 lines, in the full PRD",
    "Code: 1 line, in the full PRD",
  ]);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", /^https?:\/\/[^/]+\/documents\/saved-carts\/v\/2#s-problem$/);
  }
  for (const code of ["step 7 of the rollout", "run the check", "make carts", "```", "Code: 0"]) {
    await expect(body).not.toContainText(code);
  }
  await expect(body.locator("p", { hasText: "One command:" })).toHaveText("One command:");
  await expect(body.locator("p", { hasText: "Nothing to run:" })).toHaveText("Nothing to run:");
});
