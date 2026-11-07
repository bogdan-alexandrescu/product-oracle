import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * effort-reader (drafts.sees): the owners of a roadmap's tracks read its working draft, as the
 * API's drafts.who reads them. In the "simple-deciders" scenario (invented data) Theo Brandt
 * (commenter@example.com) owns the Guided setup track on the Onboarding roadmap, decides
 * nothing there and reviews nothing.
 * protects = after the owner moves Setup checklist a week earlier in the working draft, the
 * track owner's Gantt shows the moved dates; fails_when = the track owner reads the published
 * dates, the draft hidden from them; no_claim = the API's rule (api/tests for drafts.sees).
 */

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

async function gantt(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-gantt").click();
  const b = bar(page, "setup-checklist");
  await b.scrollIntoViewIfNeeded();
  await expect(b).toBeVisible();
  return b;
}

test.use({ viewport: { width: 1440, height: 900 } });

test("a track owner sees the working draft of their track's roadmap", async ({ page }) => {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "simple-deciders"] as const);
  await login(page, ADMIN.email);
  let b = await gantt(page);
  const was = (await b.getAttribute("data-start"))!;
  await b.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/^Moved 'Setup checklist' to /)).toBeVisible();
  await expect(b).not.toHaveAttribute("data-start", was);
  const start = (await b.getAttribute("data-start"))!;
  const end = (await b.getAttribute("data-end"))!;
  await signOut(page);
  await login(page, "commenter@example.com");
  b = await gantt(page);
  await expect(b).toHaveAttribute("data-start", start);
  await expect(b).toHaveAttribute("data-end", end);
});
