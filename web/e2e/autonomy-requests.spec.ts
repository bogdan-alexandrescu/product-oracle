import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * C1 Requests under H11 Autonomy (#150): at "Act within limits" Oracle's triage merges
 * duplicates and links requests to goals at or above the owner's confidence, then tells the
 * person who started the run. Settings › Autonomy shows Triage requests as in effect, and
 * what Oracle did on a request links to it from the Inbox. The "oracle-did-request" mock
 * scenario is the default company plus one "Oracle did" row for the seeded merged request
 * ("Remember my address", merged into "Keep the delivery address between orders").
 * Each test's card: protects=...; fails_when=...; no_claim=...
 */

const row = (page: Page, key: string) => page.getByTestId(`autonomy-row-${key}`);
const step = (page: Page, key: string, label: string) => row(page, key).getByRole("group").getByRole("button", { name: label, exact: true });

// protects=an owner sets Triage requests to Act with a reason; the row shows its limit "at 90%
// confidence or more" and no "Takes effect when C1 ships" chip, as Oracle follows it now;
// fails_when=Act cannot be saved, the limit summary is missing or wrong, or the row still
// says the level waits on C1; no_claim=what the triage does at Act (pytest
// tests/test_requests_autonomy.py covers merging, linking, the limit and Undo).
test("autonomy: Triage requests at Act is in effect at 90% confidence or more", async ({ page }) => {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-autonomy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Autonomy" })).toBeVisible();
  const requests = row(page, "requests");
  await expect(requests).toContainText("Triage requests");
  await step(page, "requests", "Act").click();
  const sheet = page.getByRole("dialog", { name: "Change Triage requests" });
  await expect(sheet.getByTestId("autonomy-to")).toContainText("Oracle merges duplicates and links requests to goals");
  await sheet.getByLabel("Why").fill("Duplicates pile up faster than we can merge them");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
  await expect(step(page, "requests", "Act")).toHaveAttribute("aria-pressed", "true");
  await expect(requests.getByTestId("autonomy-limits")).toHaveText("at 90% confidence or more");
  await expect(requests.getByTestId("autonomy-pending")).toHaveCount(0);
});

// protects=the "Oracle did" row of a request Oracle merged names both requests and how sure
// Oracle was, and is a link that opens that request on Requests, shown as Merged; fails_when=
// the row's subject has no href (plain text), or the link opens another request or none;
// no_claim=the record the API writes or Undo (pytest tests/test_requests_autonomy.py).
test("autonomy: an Oracle did row of a merged request opens the request", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "oracle-did-request"), MOCK_SCENARIO_KEY);
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-inbox").click();
  const did = page.getByTestId("inbox-oracle-actions").getByRole("row").filter({ hasText: "Remember my address" });
  await expect(did).toContainText("Triage requests");
  await did.getByRole("link", { name: "Merged “Remember my address” into “Keep the delivery address between orders” (95% sure)" }).click();
  await expect(page).toHaveURL(/\/requests\?request=[0-9a-f-]{36}$/);
  const inspector = page.getByTestId("request-inspector").filter({ visible: true });
  await expect(inspector).toContainText("Remember my address");
  await expect(inspector).toContainText("Merged into Keep the delivery address between orders");
});
