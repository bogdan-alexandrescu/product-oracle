import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * Visual QA pass A (Settings, Company and failed loads), driven through the UI on the mock
 * layer: a viewer's Sources page has no write controls (ST-1), a phone's token card shows
 * its scopes (ST-5), the phone's page picker names a role-gated page (ST-6), Sources' words
 * (ST-7), decision numbers that fit (CO-1), an empty Updates list with its action (CO-2) and
 * one notice with Try again for a list that fails to load (X-1).
 */

const PHONE = { width: 390, height: 844 };
const VIEWER = "viewer@example.com";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";

async function failGets(page: Page, path: string) {
  await page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);
}

async function stopFailing(page: Page) {
  await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
}

async function openSources(page: Page) {
  await page.getByRole("navigation", { name: "Oracle" }).getByTestId("nav-settings").click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-sources").click();
  await expect(page).toHaveURL(/\/settings\/sources$/);
  await expect(page.getByRole("list", { name: "My sources" })).toBeVisible();
}

test("ST-1: a viewer's Sources page says View only and has no write controls", async ({ page }) => {
  await login(page, VIEWER);
  await openSources(page);
  await expect(page.getByTestId("view-only")).toBeVisible();
  const main = page.getByRole("main");
  for (const name of ["Add a source", "Sync now", "Pause", "Resume", "Upload files", "Map the code", "Use"]) {
    await expect(main.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  await expect(main.getByTestId("source-reconnect")).toHaveCount(0);
  await expect(main.getByRole("form", { name: "Add a source" })).toHaveCount(0);
  // Coverage is a read: it stays in the row's menu, without Delete or Edit.
  await main.getByRole("button", { name: "More actions for Legacy all-hands chat" }).click();
  await expect(page.getByRole("menuitem", { name: "Coverage" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /^Edit / })).toHaveCount(0);
});

test("ST-1: a commenter, who may change sources, keeps them and no View only", async ({ page }) => {
  await login(page, COMMENTER);
  await openSources(page);
  await expect(page.getByRole("button", { name: "Add a source" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now" }).first()).toBeVisible();
  await expect(page.locator('[data-testid="view-only"]:visible')).toHaveCount(0);
});

test("ST-5: on a phone a token's card shows its scopes under who it acts for", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/settings/api-tokens");
  const row = page.getByTestId("token-row").filter({ hasText: "laptop cli" });
  await expect(row).toBeVisible();
  const scopes = row.getByTestId("token-scopes");
  await expect(scopes).toBeVisible();
  const forBox = await row.getByText(/^For /).boundingBox();
  const scopesBox = await scopes.boundingBox();
  expect(forBox && scopesBox && scopesBox.y >= forBox.y + forBox.height - 1).toBe(true);
});

for (const [who, email] of [
  ["a commenter", COMMENTER],
  ["a viewer", VIEWER],
] as const) {
  test(`ST-6: on a phone the page picker names Analytics for ${who}, not Choose a page`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, email);
    await page.goto("/settings/analytics");
    const picker = page.getByTestId("settings-nav-select");
    await expect(picker.locator("option:checked")).toHaveText("Analytics");
    await expect(picker.locator("option", { hasText: "Choose a page" })).toHaveCount(0);
  });
}

test("ST-7: a source over the channel cap says what to do in plain words", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const row = page.getByRole("listitem", { name: "Legacy all-hands chat" });
  await expect(row.getByTestId("last-error")).toHaveText("Pick 100 channels or fewer, then it syncs again");
});

test("ST-7: Map the code and the Analytics title each have an (i)", async ({ page }) => {
  await login(page);
  await page.goto("/settings/sources");
  const line = page.getByRole("listitem", { name: "Example repo" }).getByTestId("code-map-example-org/example-app");
  await expect(line.getByRole("button", { name: "Map the code" })).toBeVisible();
  const tip = line.getByRole("button", { name: "About code maps" });
  await tip.click();
  await expect(line.getByRole("tooltip")).toContainText("A code map is");
  await page.goto("/settings/analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "About analytics" })).toBeVisible();
});

test("CO-1: in a large company every decision number shows whole", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "large"));
  await login(page, APPROVER);
  await page.goto("/company/decisions");
  await page.getByRole("group", { name: "State" }).getByRole("button", { name: /^Any state/ }).click();
  const refs = page.getByTestId("decision-ref");
  await expect(refs).toHaveCount(200);
  await expect(refs.first()).toHaveText(/^D-\d{3}$/);
  const cut = await refs.evaluateAll((els) =>
    els.filter((el) => el.scrollWidth > el.clientWidth + 1 || (el.parentElement?.scrollWidth ?? 0) > (el.parentElement?.clientWidth ?? 0) + 1).length,
  );
  expect(cut).toBe(0);
});

test("CO-2: an empty Updates list says so in one line, with Write an update for an owner", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);
  await page.goto("/company/updates");
  const empty = page.getByTestId("updates-empty");
  await expect(empty).toContainText("No updates yet");
  await empty.getByRole("button", { name: "Write an update" }).click();
  await expect(page.getByRole("dialog", { name: "New update" })).toBeVisible();
});

const FAILED: { name: string; path: string; url: string; what: string; after: (p: Page) => Promise<void> }[] = [
  {
    name: "Requests",
    path: "/v1/requests",
    url: "/requests",
    what: "Could not load the requests.",
    after: (p) => expect(p.getByTestId("request-filters")).toBeVisible(),
  },
  {
    name: "Baseline (the Ground Truth)",
    path: "/v1/baseline/graph",
    url: "/baseline",
    what: "Could not load the baseline.",
    after: (p) => expect(p.getByRole("tab").first()).toBeVisible(),
  },
  {
    name: "Company › Strategy",
    path: "/v1/strategy/stack",
    url: "/company/strategy",
    what: "Could not load the strategy.",
    after: (p) => expect(p.getByText("Strategy stack").first()).toBeVisible(),
  },
  {
    name: "Settings › Members",
    path: "/v1/members",
    url: "/settings/members",
    what: "Could not load the members.",
    after: (p) => expect(p.getByRole("table", { name: "Members" })).toBeVisible(),
  },
];

for (const f of FAILED) {
  test(`X-1: ${f.name} that fails to load says so, keeps the server's words behind an (i), and Try again loads it`, async ({ page }) => {
    await login(page);
    await failGets(page, f.path);
    await page.goto(f.url);
    const notice = page.getByTestId("load-error");
    await expect(notice).toContainText(f.what);
    // The server's own words are behind the (i), not in the bar.
    await expect(notice.getByText("Mock failure")).toBeHidden();
    await notice.getByRole("button", { name: "About the error" }).click();
    await expect(notice.getByRole("tooltip")).toContainText("Mock failure");
    await expect(page.getByTestId("load-error")).toHaveCount(1);
    await stopFailing(page);
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("load-error")).toHaveCount(0);
    await f.after(page);
  });
}
