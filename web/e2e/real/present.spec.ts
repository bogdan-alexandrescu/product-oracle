import path from "node:path";

import { expect, test, type Page, type Response } from "@playwright/test";

import { oracle, stackState } from "./stack";

// Present mode against the real API (owner decision 2026-10-20): the deck is built on the
// export pool in a Present place of its own and kept, so the audience window, the
// presenter window and a reload of the same version are all served.
const DOC = "e2e-present";

async function login(page: Page) {
  const { email, password } = stackState();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function decks(page: Page): number[] {
  const statuses: number[] = [];
  page.on("response", (r: Response) => {
    if (new URL(r.url()).pathname === `/v1/documents/${DOC}/versions/1/deck`) statuses.push(r.status());
  });
  return statuses;
}

test("present: the audience and presenter windows and a reload of one version are all served", async ({ page, context }) => {
  expect(await oracle("push", path.join(__dirname, "fixtures", "present_draft.md"))).toContain(`Imported ${DOC} version 1`);
  await login(page);
  const audienceDecks = decks(page);

  await page.goto(`/documents/${DOC}/v/1`);
  await page.getByRole("link", { name: "Present" }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${DOC}/v/1/present$`));
  const counter = page.getByTestId("slide-counter");
  await expect(counter).toHaveText(/^1 \/ \d+$/);
  await expect(page.getByTestId("present-mode").getByRole("region", { name: /^Slide 1 of \d+: Present checkout PRD$/ })).toBeVisible();

  // The presenter's own window, opened beside the audience's: the same deck, with notes.
  const presenterPage = await context.newPage();
  const presenterDecks = decks(presenterPage);
  await presenterPage.goto(`/documents/${DOC}/v/1/present?view=presenter&slide=2`);
  const presenter = presenterPage.getByTestId("presenter-view");
  await expect(presenter).toBeVisible();
  await expect(presenterPage.getByTestId("presenter-notes")).toHaveText("Open with the drop-off number.");

  // Reloading the audience window serves the kept deck again, never a refusal.
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await expect(counter).toHaveText(/^1 \/ \d+$/);
  }
  await expect(page.getByText(/still loading|busy/i)).toHaveCount(0);
  expect([...audienceDecks, ...presenterDecks].length).toBeGreaterThanOrEqual(5);
  expect([...audienceDecks, ...presenterDecks].every((s) => s === 200)).toBe(true);
});
