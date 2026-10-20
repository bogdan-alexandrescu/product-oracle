import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { oracle, stackState } from "./stack";

// Publish against the real API: whatever the live checks say, the screen follows the
// readiness verdict (GET .../readiness), and the optional reads degrade quietly.
const DOC = "e2e-publish-check";

async function login(page: Page) {
  const { email, password } = stackState();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/documents$/);
}

test("publish: the screen follows the API's readiness verdict", async ({ page }) => {
  expect(await oracle("push", path.join(__dirname, "fixtures", "publish_draft.md"))).toContain(`Imported ${DOC} version 1`);
  await login(page);
  const verdict = await (await page.request.get(`/v1/documents/${DOC}/versions/1/readiness`)).json();

  await page.goto(`/documents/${DOC}/publish`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Publish\s*Publish check PRD v1$/);
  const hard = verdict.items.filter((i: { hard: boolean }) => i.hard);
  await expect(page.getByTestId("hard-check")).toHaveCount(hard.length);
  await expect(page.getByTestId("advisory")).toHaveCount(verdict.items.length - hard.length);

  const publish = page.getByTestId("publish-button");
  if (verdict.blocked) {
    await expect(publish).toBeDisabled();
    await expect(page.getByTestId("block-row")).not.toHaveCount(0);
  } else {
    await expect(page.getByTestId("publish-ready")).toHaveText("Ready to publish v1");
    await publish.click();
    await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
  }
});
