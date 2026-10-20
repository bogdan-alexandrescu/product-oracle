import { expect, test, type Page } from "@playwright/test";

import { fakeGoogle } from "./google-fake";
import { login } from "./helpers";

const PICKED = [
  { id: "1DocRoadmapExample", name: "Roadmap notes" },
  { id: "1DocResearchExample", name: "Research synthesis" },
];

type Drive = {
  opened: number;
  tokenClient: { client_id: string; scope: string; login_hint?: string };
  builder: { appId: string; developerKey: string; token: string; features: string[]; views: Record<string, unknown>[] };
};
const drive = (page: Page) => page.evaluate(() => (window as unknown as { __drive: Drive }).__drive);

test("sources › Google Docs: choose files from Drive, remove one, paste an id, add", async ({ page }) => {
  const asked = await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByLabel("Name").fill("Planning docs");
  // No allowlist textarea for Google Docs: the picker replaces it.
  await expect(form.getByRole("textbox", { name: /one per line/ })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();

  await form.getByRole("button", { name: "Choose files from Drive" }).click();
  const list = form.getByRole("list", { name: "Picked files" });
  await expect(list.getByRole("listitem")).toHaveText([/Roadmap notes\s*Google Doc/, /Research synthesis\s*Google Doc/]);

  const d = await drive(page);
  expect(d.tokenClient).toEqual({
    client_id: "000000000000-mock.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.file",
    login_hint: "pat@example.com",
  });
  expect(d.builder).toMatchObject({
    appId: "000000000000",
    developerKey: "mock-browser-key",
    token: "fake-drive-file-token",
    features: ["multiselectEnabled"],
  });
  expect(d.builder.views).toEqual([
    {
      viewId: "all",
      mimeTypes: "application/vnd.google-apps.document",
      includeFolders: true,
      selectFolderEnabled: false,
      mode: "list",
    },
  ]);

  await list.getByRole("button", { name: "Remove Research synthesis" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await form.getByRole("button", { name: "Paste ids" }).click();
  await form.getByLabel("Drive file ids").fill("1DocPastedExample");
  await form.getByRole("button", { name: "Add ids" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/Roadmap notes/, /1DocPastedExample\s*Drive id/]);

  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Planning docs" });
  await expect(row).toContainText("Roadmap notes, 1DocPastedExample");
  // Only Google's two scripts were asked for, and they were served by the fake.
  expect([...new Set(asked)].sort()).toEqual(["https://accounts.google.com/gsi/client", "https://apis.google.com/js/api.js"]);
});

test("sources › Google Docs: editing re-opens the picker and adds to the list", async ({ page }) => {
  await fakeGoogle(page, [{ id: "1DocPricingExample", name: "Pricing strategy" }, PICKED[0]]);
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product docs" });
  await expect(row).toContainText("Pricing strategy, Activation v2 PRD, Customer interviews Q3");
  // An unshared file is reported on its own; the source is still active.
  await expect(row.getByRole("list", { name: "Unreadable files of Product docs" })).toContainText("No accessCustomer interviews Q3");
  await expect(row).toContainText("Active");

  await row.getByRole("button", { name: "More actions for Product docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files" }).click();
  const list = row.getByRole("list", { name: "Picked files" });
  await expect(list.getByRole("listitem")).toHaveText([
    /Pricing strategy\s*Google Doc/,
    /Activation v2 PRD\s*Google Doc/,
    /Customer interviews Q3\s*Google Doc\s*No access/,
    /Roadmap notes\s*Google Doc/,
  ]);
  expect((await drive(page)).opened).toBe(1);
  await list.getByRole("button", { name: "Remove Customer interviews Q3" }).click();
  await row.getByRole("button", { name: "Save files" }).click();
  await expect(row.getByRole("status")).toHaveText("Files saved.");
  await expect(row).toContainText("Pricing strategy, Activation v2 PRD, Roadmap notes");
  await expect(row.getByRole("list", { name: "Unreadable files of Product docs" })).toHaveCount(0);
});

test("sources › Google Docs: a connection without drive.file asks to reconnect", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const legacy = page.getByRole("listitem", { name: "Drive folders" });
  await expect(legacy.getByTestId("reconnect-to-choose")).toContainText("Reconnect to choose files");
  await expect(legacy.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/settings/connections");
  await expect(legacy).toContainText("1FolderProductExample");

  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByLabel("Connection").selectOption({ label: "old-drive@example.com" });
  await expect(form.getByTestId("reconnect-to-choose")).toBeVisible();
  await expect(form.getByRole("button", { name: "Choose files from Drive" })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();
});

test("connections › Google: an old grant shows Reconnect to choose files", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections");
  const google = page.getByTestId("connection-card-google");
  await google.getByRole("button", { name: "Paste a token" }).click();
  await google.getByLabel("Token", { exact: true }).fill("legacy-google-token");
  await google.getByRole("button", { name: "Connect", exact: true }).click();
  const reconnect = google.getByRole("button", { name: "Reconnect to choose files" });
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(page).toHaveURL(/connected=google/);
  await expect(google.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(google.getByRole("button", { name: "Reconnect to choose files" })).toHaveCount(0);
});

test("sources › the page's CSP allows exactly Google's picker hosts", async ({ page }) => {
  const resp = await page.request.get("/settings/sources");
  const csp = resp.headers()["content-security-policy"];
  expect(csp).toBeTruthy();
  const hosts = new Set([...csp.matchAll(/https:\/\/([^/\s;]+)/g)].map((m) => m[1]));
  expect([...hosts].sort()).toEqual(["accounts.google.com", "apis.google.com", "docs.google.com"]);
  expect(csp).not.toMatch(/\*|https:(?!\/\/)|'unsafe-eval'/);
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));
  expect(directive("script-src")).toBe("script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com/gsi/");
  expect(directive("frame-src")).toBe("frame-src 'self' blob: https://docs.google.com https://accounts.google.com/gsi/");
});
