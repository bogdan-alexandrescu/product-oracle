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
  await expect(page).toHaveURL(/\/home$/);
}

test("publish: the screen follows the API's readiness verdict", async ({ page }) => {
  expect(await oracle("push", path.join(__dirname, "fixtures", "publish_draft.md"))).toContain(`Imported ${DOC} version 1`);
  await login(page);
  // The verdict approve asks for (T2 publish gate): purpose=publish.
  const verdict = await (await page.request.get(`/v1/documents/${DOC}/versions/1/readiness?purpose=publish`)).json();
  expect(verdict.purpose).toBe("publish");

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
    await expect(page.getByTestId("publish-ready")).toHaveText(/^(Ready to publish v1|Publishable, but .+)$/);
    await publish.click();
    await page.getByRole("dialog", { name: "Publish v1?" }).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("published-chip")).toHaveText("Published v1");
  }
});

test("publish gate: a blocker linked after the page loaded is refused by the API, inside the dialog", async ({ page }) => {
  const doc = "e2e-publish-gate";
  expect(await oracle("push", path.join(__dirname, "fixtures", "publish_gate_draft.md"))).toContain(`Imported ${doc} version 1`);
  await login(page);
  await page.goto(`/documents/${doc}/publish`);
  await expect(page.getByTestId("publish-ready")).toHaveText(/^(Ready to publish v1|Publishable, but .+)$/);
  await page.getByTestId("publish-button").click();
  const dialog = page.getByRole("dialog", { name: "Publish v1?" });
  await expect(dialog).toBeVisible();

  // Meanwhile a critical hard blocker is linked to the PRD.
  const { id } = await (await page.request.get(`/v1/documents/${doc}`)).json();
  const statement = "The partner API allows 100 requests a minute per company";
  const created = await page.request.post("/v1/blockers", {
    data: {
      key: "e2e-partner-rate-limit", statement, type: "hard", limit_kind: "capacity",
      third_party: "Example partner API", severity: "critical", document_ids: [id],
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  const refusal = dialog.getByTestId("publish-refusal");
  await expect(refusal).toContainText("Not published");
  await expect(refusal).toContainText("1 block");
  await expect(dialog.getByTestId("refusal-block")).toHaveText([statement]);
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();

  // Nothing was recorded: the version is not approved.
  const after = await (await page.request.get(`/v1/documents/${doc}`)).json();
  expect(after.status).not.toBe("approved");
  expect(after.approved_version ?? null).toBeNull();
  const approve = await page.request.post(`/v1/documents/${doc}/versions/1/approve`);
  expect(approve.status()).toBe(409);
  expect((await approve.json()).detail).toBe(`1 block: ${statement}`);
});
