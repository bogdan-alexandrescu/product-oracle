import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";

import { expect, test } from "./test";

import { login, openSection } from "./helpers";

/*
 * A verdict saves after its click, and the bar shows it at once ("Approved · Not saved yet").
 * A reader who opens another section before the save lands stays on that section: the version
 * page used to put them back on the section they had just reviewed when the save answered.
 *
 * protects = the section opened during the save is still the open one after the save lands.
 * fails_when = the save's answer opens the reviewed section again.
 */

const CARTS = "/documents/saved-carts/v/2";
const SAVE = "PUT /v1/documents/saved-carts/versions/2/sections/summary/review";

test("a section opened while a verdict saves stays the current one when the save lands", async ({ page }) => {
  await login(page);
  await page.evaluate(([key, call, msKey]) => {
    localStorage.setItem(key, call);
    localStorage.setItem(msKey, "2000");
  }, [MOCK_SLOW_KEY, SAVE, MOCK_SLOW_MS_KEY]);
  await page.goto(CARTS);
  const summary = await openSection(page, "summary");
  const bar = summary.getByTestId("review-bar");
  await bar.getByRole("button", { name: "Approve" }).click();
  await bar.getByTestId("verdict-submit").click();

  // Before the save answers, the reader moves on to the Roadmap.
  const roadmap = await openSection(page, "brief-roadmap");
  await expect(page).toHaveURL(/#brief-roadmap$/);
  // The save lands (the contents row marks Summary approved), and the Roadmap is still current.
  await expect(page.locator('a[data-outline-key="summary"]').filter({ visible: true })).toHaveAccessibleName("1 Summary Approved", { timeout: 5_000 });
  await expect(roadmap).toBeVisible();
  // Summary is no longer the current section: its review bar is hidden, Roadmap's is the one shown.
  await expect(summary.getByTestId("review-bar")).toBeHidden();
  await expect(roadmap.getByRole("button", { name: "Expand General release" })).toBeVisible();
});
