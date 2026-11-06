import { WEBHOOKS_SCENARIO } from "../lib/api/mock/webhooks";
import { login } from "./helpers";
import { expect, test } from "./test";

// G-7: the delivery log's time-zone line and the Share a link sentence are not on the page;
// each sits in the (i) beside its heading.

test("webhooks: the delivery log's time zone line is in its (i), not on the page", async ({ page }) => {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ["po-mock-scenario", WEBHOOKS_SCENARIO]);
  await login(page);
  await page.goto("/settings/webhooks");
  await page.getByTestId("webhook-row").filter({ visible: true }).filter({ hasText: "Deploy notifier" }).click();
  const inspector = page.getByTestId("webhook-inspector");
  await expect(inspector.getByTestId("delivery-row").first()).toBeVisible();
  const line = page.getByText("Times are in Company time.");
  await expect(line.filter({ visible: true })).toHaveCount(0);
  const tip = inspector.getByRole("button", { name: "About the delivery log" });
  await tip.hover();
  await expect(line.filter({ visible: true })).toHaveCount(1);
});

test("share: the Share a link sentence is in the (i) beside Audience, not on the page", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto("/documents/example-labs-roadmap");
  await expect(page.getByRole("button", { name: "Share a link", exact: true })).toBeVisible();
  const line = page.getByText(/^Share a link sends a published version/);
  await expect(line.filter({ visible: true })).toHaveCount(0);
  await page.getByRole("button", { name: "About sharing" }).hover();
  await expect(line.filter({ visible: true })).toHaveCount(1);
});
