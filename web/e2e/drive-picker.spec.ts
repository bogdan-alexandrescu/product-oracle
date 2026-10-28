import { expect, test, type Page } from "./test";

import { fakeGoogle, FOLDER } from "./google-fake";
import { login } from "./helpers";

const PICKED = [
  { id: "1DocRoadmapExample", name: "Roadmap notes" },
  { id: "1DocResearchExample", name: "Research synthesis" },
];
const SPECS_FOLDER = { id: "1FolderPlanningExample", name: "Planning", mimeType: FOLDER };

type Drive = {
  opened: number;
  tokenClient: { client_id: string; scope: string; login_hint?: string };
  signIns: { inClick: boolean }[];
  builder: { appId: string; developerKey: string; token: string; features: string[]; views: Record<string, unknown>[] };
};
const drive = (page: Page) => page.evaluate(() => (window as unknown as { __drive: Drive }).__drive);

test("sources › Google Docs: choose files and a folder from Drive, remove one, paste an id, add", async ({ page }) => {
  const asked = await fakeGoogle(page, [SPECS_FOLDER, ...PICKED]);
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByLabel("Name").fill("Planning docs");
  // No allowlist textarea for Google Docs: the picker replaces it.
  await expect(form.getByRole("textbox", { name: /one per line/ })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();

  await form.getByRole("button", { name: "Choose from Drive" }).click();
  const list = form.getByRole("list", { name: "Picked files and folders" });
  await expect(list.getByRole("listitem")).toHaveText([
    /Planning\s*Folder · every doc in it/,
    /Roadmap notes\s*Google Doc/,
    /Research synthesis\s*Google Doc/,
  ]);

  const d = await drive(page);
  // The browser token has the same scope as the API's Google connection.
  expect(d.tokenClient).toEqual({
    client_id: "000000000000-mock.apps.googleusercontent.com",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    login_hint: "pat@example.com",
  });
  expect(d.signIns).toEqual([{ inClick: true }]);
  expect(d.builder).toMatchObject({
    appId: "000000000000",
    developerKey: "mock-browser-key",
    token: "fake-drive-token",
    features: ["multiselectEnabled"],
  });
  // Folders can be picked as well as Google Docs.
  expect(d.builder.views).toEqual([
    {
      viewId: "all",
      mimeTypes: "application/vnd.google-apps.document,application/vnd.google-apps.folder",
      includeFolders: true,
      selectFolderEnabled: true,
      // Shared drives' folders and docs can be picked too.
      enableDrives: true,
      mode: "list",
    },
  ]);

  await list.getByRole("button", { name: "Remove Research synthesis" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await form.getByRole("button", { name: "Paste ids" }).click();
  await form.getByLabel("Drive file ids").fill("1DocPastedExample");
  await form.getByRole("button", { name: "Add ids" }).click();
  await expect(list.getByRole("listitem")).toHaveText([/Planning/, /Roadmap notes/, /1DocPastedExample\s*Drive id/]);

  await form.getByRole("button", { name: "Add source" }).click();
  const row = page.getByRole("listitem", { name: "Planning docs" });
  await expect(row).toContainText("Roadmap notes, 1DocPastedExample");
  await expect(row).toContainText("FoldersPlanning");
  // Saved as {docs, folders, names}: the editor reads it back.
  await row.getByRole("button", { name: "More actions for Planning docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files and folders" }).click();
  await expect(row.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem")).toHaveText([
    /Planning\s*Folder · every doc in it/,
    /Roadmap notes\s*Google Doc/,
    /1DocPastedExample\s*Drive id/,
  ]);
  // Only Google's two scripts were asked for, and they were served by the fake.
  expect([...new Set(asked)].sort()).toEqual(["https://accounts.google.com/gsi/client", "https://apis.google.com/js/api.js"]);
});

test("sources › Google Docs: sign-in opens on the click even when Google loads slowly", async ({ page }) => {
  await fakeGoogle(page, PICKED, { delayMs: 1500 });
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  // Until Google's scripts are in, the button waits instead of opening a popup later.
  await expect(form.getByRole("button", { name: "Loading Drive…" })).toBeDisabled();
  await form.getByRole("button", { name: "Choose from Drive" }).click();
  await expect(form.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem")).toHaveCount(2);
  expect((await drive(page)).signIns).toEqual([{ inClick: true }]);
});

test("sources › Google Docs: editing adds to the list from the picker; removing a doc and a folder", async ({ page }) => {
  await fakeGoogle(page, [{ id: "1DocPricingExample", name: "Pricing strategy" }, PICKED[0]]);
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product docs" });
  await expect(row).toContainText("Pricing strategy, Activation v2 PRD, Customer interviews Q3");
  await expect(row).toContainText("FoldersProduct specs, Vendor research");
  await expect(row).toContainText("3 items");
  // An unshared file and a folder Oracle lost access to are reported on their own (the
  // folder's docs are hidden until it can be read again), and docs owned outside the
  // company or in a shared drive outside it are listed as skipped, per reason, with their
  // count and names; the source is still active.
  const notes = row.getByRole("list", { name: "Sync notes for Product docs" });
  await expect(notes.getByRole("listitem")).toHaveText([
    /Lost access\s*to\s*Vendor research\s*its docs are hidden until Oracle can read it again/,
    /No access\s*Customer interviews Q3/,
    /Skipped: owned outside example.com\s*3 docs\s*Agency SOW 2026, Partner pricing sheet, Contractor onboarding notes/,
    /Skipped: in a shared drive outside the company\s*1 doc\s*Joint launch plan/,
  ]);
  await expect(row).toContainText("Active");

  await row.getByRole("button", { name: "More actions for Product docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files and folders" }).click();
  const list = row.getByRole("list", { name: "Picked files and folders" });
  await expect(list.getByRole("listitem")).toHaveText([
    /Product specs\s*Folder · every doc in it$/,
    /Vendor research\s*Folder · every doc in it\s*Lost access/,
    /Pricing strategy\s*Google Doc/,
    /Activation v2 PRD\s*Google Doc/,
    /Customer interviews Q3\s*Google Doc\s*No access/,
  ]);
  // The picker opens on a click, not by itself.
  expect((await drive(page))?.opened ?? 0).toBe(0);
  await row.getByRole("button", { name: "Choose from Drive" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await expect(list.getByRole("listitem").last()).toHaveText(/Roadmap notes\s*Google Doc/);
  expect((await drive(page)).signIns).toEqual([{ inClick: true }]);

  await list.getByRole("button", { name: "Remove Customer interviews Q3" }).click();
  await list.getByRole("button", { name: "Remove Product specs" }).click();
  await row.getByRole("button", { name: "Save files" }).click();
  await expect(row.getByRole("status")).toHaveText("Files saved.");
  await expect(row).toContainText("Pricing strategy, Activation v2 PRD, Roadmap notes");
  await expect(row).not.toContainText("Product specs");
  // Narrowing takes effect on save: the doc that came from the removed folder is gone now.
  await expect(row).toContainText("2 items");
  // Notes about what is still picked stay (the lost folder); the rest wait for the next sync.
  await expect(notes.getByRole("listitem")).toHaveText([/Lost access\s*to\s*Vendor research/]);

  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(row).toContainText("2 items");
});

test("sources › Google Docs: removing a folder and saving hides its docs at once, without a sync", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  // A doc from the "Product specs" folder is in search.
  await page.goto("/sources");
  await page.getByLabel("Search", { exact: true }).fill("guests");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await expect(page.getByTestId("search-hit")).toContainText("Checkout spec");

  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product docs" });
  await expect(row).toContainText("3 items");
  await row.getByRole("button", { name: "More actions for Product docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files and folders" }).click();
  await row.getByRole("button", { name: "About choosing from Drive" }).click();
  await expect(page.getByRole("tooltip", { name: /Removing one hides what came from it when you save/ })).toBeVisible();
  await page.keyboard.press("Escape");
  const list = row.getByRole("list", { name: "Picked files and folders" });
  await list.getByRole("button", { name: "Remove Product specs" }).click();
  await row.getByRole("button", { name: "Save files" }).click();
  await expect(row.getByRole("status")).toHaveText("Files saved.");
  await expect(row).toContainText("2 items");

  // Gone from search too, with no sync run.
  await page.goto("/sources");
  await page.getByLabel("Search", { exact: true }).fill("guests");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Nothing in your sources matches “guests”.")).toBeVisible();
  await expect(page.getByTestId("search-hit")).toHaveCount(0);
});

test("sources › Google Docs: a folder Oracle lost access to says so on the source page", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product docs" });
  const notes = row.getByRole("list", { name: "Sync notes for Product docs" });
  const lost = notes.getByRole("listitem", { name: "Lost access to Vendor research" });
  await expect(lost).toHaveText(/Lost access\s*to\s*Vendor research\s*its docs are hidden until Oracle can read it again/);
  await expect(lost.getByText("Lost access", { exact: true })).toHaveAttribute("title", /removed, or no longer shared with you/);
  // Still said after a sync that cannot read it.
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(lost).toBeVisible();

  await row.getByRole("button", { name: "More actions for Product docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files and folders" }).click();
  const list = row.getByRole("list", { name: "Picked files and folders" });
  await expect(list.getByRole("listitem", { name: "Vendor research" })).toContainText("Lost access");
});

test("sources › Google Docs: copy says plainly what Oracle can read", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByRole("button", { name: "About choosing from Drive" }).click();
  await expect(page.getByRole("tooltip", { name: /^Oracle can read your Drive; it pulls in only the files and folders you choose here\./ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("reads only the Google Docs");
});

test("sources › Google Docs: a connection without drive.readonly asks to reconnect", async ({ page }) => {
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
  await expect(form.getByRole("button", { name: "Choose from Drive" })).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Add source" })).toBeDisabled();
});

test("connections › Google: a drive.readonly grant needs no reconnect; a drive.file one does", async ({ page }) => {
  await login(page);
  await page.goto("/settings/connections");
  const google = page.getByTestId("connection-card-google");
  await google.getByRole("button", { name: "Paste a token" }).click();
  await google.getByLabel("Token", { exact: true }).fill("legacy-google-token");
  await google.getByRole("button", { name: "Connect", exact: true }).click();
  const reconnect = google.getByRole("button", { name: "Reconnect to choose files" });
  await expect(reconnect).toBeVisible();
  await expect(page.locator("body")).not.toContainText("reads only the Google Docs");
  await reconnect.click();
  await expect(page).toHaveURL(/connected=google/);
  await expect(google.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(google.getByRole("button", { name: "Reconnect to choose files" })).toHaveCount(0);
});

test("CSP: every page allows exactly Google's picker hosts (and Notion's icon hosts for images), so in-app navigation to Sources is covered", async ({ page }) => {
  for (const path of ["/settings/sources", "/", "/settings/connections"]) {
    const resp = await page.request.get(path);
    const csp = resp.headers()["content-security-policy"];
    expect(csp, path).toBeTruthy();
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));
    // Outside this origin: Google's picker hosts for scripts, frames, requests and styles.
    const notImages = csp
      .split("; ")
      .filter((d) => !d.startsWith("img-src "))
      .join("; ");
    const hosts = new Set([...notImages.matchAll(/https:\/\/([^/\s;]+)/g)].map((m) => m[1]));
    expect([...hosts].sort()).toEqual(["accounts.google.com", "apis.google.com", "docs.google.com"]);
    expect(notImages).not.toMatch(/\*|https:(?!\/\/)|'unsafe-eval'|blob:/);
    expect(csp).not.toMatch(/ \*[ ;]|https:(?!\/\/)|blob:/);
    // Everything not named below stays on this origin.
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("style-src")).toBe("style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style");
    // Images: this origin, data:, and only the hosts Notion serves page icons from.
    expect(directive("img-src")).toBe(
      "img-src 'self' data: https://notion.so https://*.notion.so https://notion.site https://*.notion.site " +
        "https://notion-static.com https://*.notion-static.com https://prod-files-secure.s3.us-west-2.amazonaws.com",
    );
    expect(directive("font-src")).toBe("font-src 'self' data:");
    expect(directive("script-src")).toBe("script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com/gsi/");
    expect(directive("frame-src")).toBe("frame-src 'self' https://docs.google.com https://accounts.google.com/gsi/");
    expect(directive("connect-src")).toBe("connect-src 'self' https://accounts.google.com/gsi/");
  }
});

test("CSP: after in-app navigation to Sources, the picker still loads under the policy", async ({ page }) => {
  const asked = await fakeGoogle(page, PICKED);
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await login(page);
  await page.goto("/settings/connections");
  await page.evaluate(() => {
    // Mark this document: a full reload would lose it.
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  await page.getByTestId("nav-sources").first().click();
  await expect(page).toHaveURL(/\/settings\/sources/);
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByRole("button", { name: "Choose from Drive" }).click();
  await expect(form.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem")).toHaveCount(2);
  expect(asked.length).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

test("sources › Google Docs: pasted ids must be Drive ids; links copied from Drive work", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByRole("button", { name: "Paste ids" }).click();
  await form
    .getByLabel("Drive file ids")
    .fill(
      [
        "https://docs.google.com/document/d/1DocLinkedExample/edit",
        "https://drive.google.com/drive/folders/1FolderLinkedExample",
        "root",
        "root?x='",
      ].join("\n"),
    );
  await form.getByRole("button", { name: "Add ids" }).click();
  const list = form.getByRole("list", { name: "Picked files and folders" });
  await expect(list.getByRole("listitem")).toHaveText([/1DocLinkedExample\s*Drive id/, /1FolderLinkedExample\s*Folder/]);
  // What is not an id stays in the box, with a reason.
  await expect(form.getByText("Not a Drive file or folder id: root, root?x=")).toBeVisible();
  await expect(form.getByLabel("Drive file ids")).toHaveValue("root\nroot?x='");
});

test("sources › Google Docs: a stale save shows the message, saves nothing, and Reload shows the current picks", async ({ page }) => {
  await fakeGoogle(page, PICKED);
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Product docs" });
  await row.getByRole("button", { name: "More actions for Product docs" }).click();
  await row.getByRole("menuitem", { name: "Edit files and folders" }).click();
  const list = row.getByRole("list", { name: "Picked files and folders" });
  await expect(list.getByRole("listitem")).toHaveCount(5);

  // Another tab narrows the source to one doc while this form still has five.
  await page.evaluate(() => {
    const key = "po-mock-sources-v2";
    const db = JSON.parse(localStorage.getItem(key)!);
    const s = db.sources.find((x: { name: string }) => x.name === "Product docs");
    s.config = { docs: ["1DocPricingExample"], folders: [], names: { "1DocPricingExample": "Pricing strategy" } };
    s.config_version += 1;
    localStorage.setItem(key, JSON.stringify(db));
  });

  await list.getByRole("button", { name: "Remove Customer interviews Q3" }).click();
  await row.getByRole("button", { name: "Save files" }).click();
  const alert = row.getByRole("alert");
  await expect(alert).toContainText("This source changed since you opened it. Reload to see the current picks.");
  await expect(alert).toContainText("Nothing was saved");
  await expect(row.getByRole("status")).toHaveCount(0);

  await alert.getByRole("button", { name: "Reload" }).click();
  await expect(alert).toHaveCount(0);
  await expect(row.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem")).toHaveText([/Pricing strategy\s*Google Doc/]);
});
