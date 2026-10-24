import { expect, test, type Page } from "@playwright/test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * #524 review: Internal launch work follows H11 Autonomy (Mark launched publishes internal
 * entries and tells member requesters at "Act within limits"), so Settings › Autonomy shows
 * it as in effect; and what Oracle did on a launch links to that launch from the Inbox.
 * Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// protects=an owner sets Internal launch work to Act with a reason; the row shows its fixed
// limit and no "Takes effect when H6 Launches and changelog ships" chip, as Oracle follows it
// now; fails_when=the row still says the level waits on H6; no_claim=what Mark launched does
// (pytest tests/test_launches.py covers it).
test("autonomy: Internal launch work at Act is in effect, with no pending chip", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  const launches = row(page, "launches");
  await expect(launches).toContainText("Internal launch work");
  await expect(launches.getByTestId("autonomy-pending")).toHaveCount(0);
  await step(page, "launches", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Internal launch work" });
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Oracle publishes internal changelog entries");
  await sheet.getByLabel("Why").fill("Internal launch notes are routine");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "launches", "Act")).toHaveAttribute("aria-pressed", "true");
  await expect(launches.getByTestId("autonomy-limits")).toHaveText("internal only");
  await expect(launches.getByTestId("autonomy-pending")).toHaveCount(0);
});

// protects=the "Oracle did" row of a launch Oracle acted on is a link that opens that launch;
// fails_when=the row's subject has no href, so its summary is plain text; no_claim=the record
// the API writes (pytest tests/test_launches.py covers its subject).
test("autonomy: an Oracle did row of a launch opens the launch", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "oracle-did-launch-ritual"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Usage export launched" });
  await expect(did).toContainText("Internal launch work");
  await did.getByRole("link", { name: /^Usage export launched: Oracle published/ }).click();
  await expect(page).toHaveURL(/\/roadmap\/launches\?launch=[0-9a-f-]{36}$/);
  await expect(page.getByTestId("launch-inspector").filter({ visible: true })).toContainText("Usage export");
});
