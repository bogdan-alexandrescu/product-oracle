import { expect, test, type Page } from "@playwright/test";

import { MOCK_CONSENT, MOCK_HANDLES } from "../app/oauth/consent/mock";
import { ADMIN, login } from "./helpers";

const CALLBACK = new URL(MOCK_CONSENT.redirect_uri);

/** Stands in for the MCP client's loopback listener; records where the browser landed. */
async function fakeClient(page: Page) {
  await page.route(`${CALLBACK.origin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Client callback</h1>" }),
  );
}

test("consent: signed out goes to sign-in first, then approve returns a code", async ({ page }) => {
  await fakeClient(page);
  await page.goto("/oauth/consent?request=mock-handle");
  await expect(page).toHaveURL(/\/login\?next=/);

  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/oauth\/consent\?request=mock-handle$/);

  await expect(page.getByRole("heading", { name: "Connect an MCP client" })).toBeVisible();
  const consent = page.getByTestId("consent");
  await expect(consent).toContainText(`${MOCK_CONSENT.client_name} wants to use Product Oracle as you.`);
  await expect(consent).toContainText("oracle:read");
  await expect(consent).toContainText("oracle:write");
  await expect(page.getByTestId("consent-user")).toHaveText(ADMIN.email);
  await expect(consent).toContainText("Owner");
  await expect(consent).toContainText(CALLBACK.host);
  await expect(page.getByTestId("consent-effective-role")).toHaveCount(0);

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("heading", { name: "Client callback" })).toBeVisible();
  const landed = new URL(page.url());
  expect(landed.origin + landed.pathname).toBe(MOCK_CONSENT.redirect_uri);
  expect(landed.searchParams.get("code")).toBe("poc_mock-code");
  expect(landed.searchParams.get("state")).toBe(MOCK_CONSENT.state);
});

test("consent: deny returns access_denied", async ({ page }) => {
  await fakeClient(page);
  await login(page);
  await page.goto("/oauth/consent?request=mock-handle");
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("heading", { name: "Client callback" })).toBeVisible();
  const landed = new URL(page.url());
  expect(landed.searchParams.get("error")).toBe("access_denied");
  expect(landed.searchParams.get("code")).toBeNull();
});

test("consent: read-only access says the client acts as a viewer", async ({ page }) => {
  await login(page);
  await page.goto(`/oauth/consent?request=${MOCK_HANDLES.readOnly}`);
  const consent = page.getByTestId("consent");
  await expect(consent).toContainText("oracle:read");
  await expect(consent).not.toContainText("oracle:write");
  await expect(page.getByTestId("consent-effective-role")).toContainText("viewer rights only");
});

test("consent: an expired or missing request shows an error and no buttons", async ({ page }) => {
  await login(page);
  await page.goto(`/oauth/consent?request=${MOCK_HANDLES.expired}`);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("This request has expired");
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);

  await page.goto("/oauth/consent");
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText("Start again from your MCP client");
});
