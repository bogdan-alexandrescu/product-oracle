import { expect, test } from "@playwright/test";

import { confirmedEntity, login } from "./ui";

// H10 Reasoned no (PR #541) against the real API: Disqualify with a reason and its basis logs
// a decision, and the Why not panel opens.
const TITLE = "Export every board at once";

test("requests: an owner says no as Already possible, names the feature and sees Why not", async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  const feature = await confirmedEntity(page, { type: "feature", key: "e2e-board-export", title: "Board export" });
  const filed = await page.request.post("/v1/requests", {
    data: { title: TITLE, body: "Asked on a call", channel: "sales", requester_name: "An ops lead at a customer", requester_kind: "customer" },
  });
  expect(filed.status(), await filed.text()).toBe(201);

  await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/requests$/);
  await page.getByTestId("request-row").filter({ hasText: TITLE }).getByRole("button", { name: TITLE }).click();
  const panel = page.getByTestId("request-inspector");
  await expect(panel.getByRole("heading", { name: TITLE })).toBeVisible();
  await panel.getByRole("button", { name: "Disqualify", exact: true }).click();
  const form = panel.locator("form").filter({ has: page.getByRole("button", { name: "Disqualify request" }) });
  await form.getByLabel("Reason").selectOption({ label: "Already possible" });
  await form.getByLabel("Feature").selectOption({ label: feature.title });
  await form.getByRole("button", { name: "Disqualify request" }).click();

  await expect(panel.getByTestId("decision-chip")).toHaveText(new RegExp(`^D-\\d+ Say no to ${TITLE}$`));
  await expect(panel).toContainText(`Basis: ${feature.title}`);
  await expect(page.getByTestId("why-not")).toBeVisible();
});
