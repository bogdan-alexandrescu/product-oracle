import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * #1586: "could not ask" and "the answer is none" never look alike. A read still loading says
 * loading; a read that failed says so, with its reason behind an (i); only an answer is drawn as
 * empty. Each case is checked both ways: answered, then loading or failed.
 */

async function openHome(page: Page) {
  await login(page);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
  await expect(page.getByTestId("home-goal-G3")).toBeVisible();
}

const failGets = (page: Page, path: string) => page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);

/** Waits until the mock has been asked a GET whose path and query start with `call`. */
async function asked(page: Page, call: string) {
  await page.waitForFunction((c) => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).some((l) => l.startsWith(`GET ${c}`)), call);
}

test("Home: a goal's trend that could not be read says so, never no trend", async ({ page }) => {
  await openHome(page);
  const activation = page.getByTestId("home-goal-G3");
  await expect(activation.getByTestId("goal-trend")).toBeVisible();
  await expect(activation.getByTestId("goal-trend-failed")).toHaveCount(0);
  const href = await activation.getByTestId("goal-open").getAttribute("href");
  const id = new URL(href!, "http://example.com").searchParams.get("entity");

  await failGets(page, `/v1/baseline/entities/${id}/measurements`);
  await page.reload();
  const failed = page.getByTestId("home-goal-G3").getByTestId("goal-trend-failed");
  await expect(failed).toContainText("Could not load the trend.");
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  await expect(page.getByTestId("home-goal-G3").getByTestId("goal-trend")).toHaveCount(0);
});

test("Home: blockers that could not be read say so, never a line per check", async ({ page }) => {
  await openHome(page);
  const inspector = page.getByTestId("home-inspector");
  const blockers = inspector.getByTestId("inspector-blockers");
  await expect(blockers).toContainText("The address lookup service allows 100 requests a minute per company");
  await expect(blockers.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/blockers");
  await page.reload();
  const failed = page.getByTestId("home-inspector").getByTestId("inspector-blockers");
  await expect(failed.getByTestId("load-error")).toContainText("Could not load the blockers.");
  await expect(failed.getByTestId("inspector-blocker")).toHaveCount(0);
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
});

test("Home: a PRD's readiness that could not be read says so in Blockers", async ({ page }) => {
  await openHome(page);
  const inspector = page.getByTestId("home-inspector");
  await expect(inspector.getByTestId("inspector-blockers")).toBeVisible();
  const version = (await inspector.getByText(/^v\d+$/).first().textContent())!.slice(1);
  const doc = (await page.locator('[data-testid="flight-row"][aria-selected="true"]').getAttribute("data-document"))!;

  await failGets(page, `/v1/documents/${doc}/versions/${version}/readiness`);
  await page.reload();
  const failed = page.getByTestId("home-inspector").getByTestId("inspector-blockers");
  await expect(failed.getByTestId("load-error")).toContainText("Could not load the blockers.");
  await expect(page.getByTestId("home-inspector").getByTestId("stat-blockers")).toContainText("–");
});

test.describe("PRDs list, no PRDs yet", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  });

  test("while the ideas load, the list is loading, not No PRDs yet", async ({ page }) => {
    await login(page);
    await page.goto("/documents");
    await expect(page.getByTestId("prds-empty")).toBeVisible();

    await page.evaluate(() => {
      localStorage.setItem("po-mock-slow", "/v1/intakes");
      localStorage.setItem("po-mock-slow-ms", "8000");
    });
    await page.reload();
    await asked(page, "/v1/documents?kind=prd");
    const start = Date.now();
    await expect(page.getByTestId("documents-table").locator("table")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("prds-empty")).toHaveCount(0);
    // The PRDs answer at once; No PRDs yet waits for the held ideas, never only for the PRDs.
    await expect(page.getByTestId("prds-empty")).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - start).toBeGreaterThan(6_000);
  });

  test("ideas that could not be read say so beside No PRDs yet", async ({ page }) => {
    await login(page);
    await page.goto("/documents");
    await expect(page.getByTestId("prds-empty")).toBeVisible();
    await expect(page.getByTestId("load-error")).toHaveCount(0);

    await failGets(page, "/v1/intakes");
    await page.reload();
    await expect(page.getByTestId("load-error")).toContainText("Could not load the ideas.");
    await expect(page.getByTestId("prds-empty")).toBeVisible();
  });
});

test("a roadmap item's history that could not be read says so, never no history", async ({ page }) => {
  await login(page);
  await page.goto("/documents/annual-billing/v/2/roadmap");
  const visible = (id: string) => page.getByTestId(id).filter({ visible: true });
  await visible("roadmap-item-row").filter({ hasText: "Public signup" }).click();
  await expect(visible("item-history").locator("li")).toHaveText(["Draft v1 · Next", "Draft v2 · Now"]);
  await expect(visible("item-history").getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/roadmap-items/history");
  await page.reload();
  await visible("roadmap-item-row").filter({ hasText: "Public signup" }).click();
  await expect(visible("item-history").getByTestId("load-error")).toContainText("Could not load the history.");
  await expect(visible("item-history").locator("li")).toHaveCount(0);
});

test("Publish: a version that could not be read says so, never every section reviewed", async ({ page }) => {
  await login(page);
  await page.goto("/documents/visit-reminders/publish");
  await expect(page.getByTestId("publish-button")).toHaveText("Publish v1");
  await expect(page.getByRole("alert").filter({ hasText: "Mock failure" })).toHaveCount(0);

  await expect(page.getByTestId("publish-ready")).toBeVisible();
  await expect(page.getByTestId("publish-ready")).not.toContainText("Could not check");
  await expect(page.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/documents/visit-reminders/versions/1");
  await page.reload();
  const failed = page.getByTestId("load-error").filter({ hasText: "Could not load the sections." });
  await expect(failed).toBeVisible();
  await failed.getByRole("button", { name: "About the error" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Mock failure");
  await expect(page.getByTestId("publish-ready")).toHaveText("Could not check the sections");
  await expect(page.getByTestId("publish-ready")).not.toContainText("Ready to publish");
});

for (const [what, path] of [
  ["the blocker plan", "/v1/documents/visit-reminders/blocker-strategy"],
  ["the staged changes", "/v1/documents/visit-reminders/staged-changes"],
] as const) {
  test(`Publish: ${what} that could not be read say so, never none`, async ({ page }) => {
    await login(page);
    await page.goto("/documents/visit-reminders/publish");
    await expect(page.getByTestId("publish-button")).toHaveText("Publish v1");
    await expect(page.getByTestId("load-error")).toHaveCount(0);

    await failGets(page, path);
    await page.reload();
    await expect(page.getByTestId("publish-button")).toHaveText("Publish v1");
    await expect(page.getByTestId("load-error")).toContainText(`Could not load ${what}.`);
  });
}

test("Publish: a roadmap's publications that could not be read say so, never not published", async ({ page }) => {
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/publish");
  await expect(page.getByTestId("publish-share-note")).toBeVisible();
  await expect(page.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/documents/usage-alerts-roadmap/publications");
  await page.reload();
  await expect(page.getByTestId("load-error")).toContainText("Could not load the publications.");
});

test("Publish: open questions that could not be read say so, never none", async ({ page }) => {
  await login(page);
  await page.goto("/documents/visit-reminders/publish");
  await expect(page.getByTestId("publish-button")).toHaveText("Publish v1");
  await expect(page.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/questions");
  await page.reload();
  await expect(page.getByTestId("load-error")).toContainText("Could not load the open questions.");
});

/** The first GET the mock answered whose path matches `re` (its query left off). */
async function calledPath(page: Page, re: RegExp): Promise<string> {
  const handle = await page.waitForFunction(
    (src) => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).map((l) => l.replace(/^GET /, "").split("?")[0]).find((p) => new RegExp(src).test(p)),
    re.source,
  );
  return (await handle.jsonValue()) as string;
}

test("a PRD's review states that could not be read say so, never no re-review asked", async ({ page }) => {
  await login(page);
  await page.goto("/documents/visit-reminders/v/1");
  const doc = page.getByRole("article", { name: "Document" }).filter({ visible: true });
  await expect(doc.locator("h2, h3").first()).toBeVisible();
  await expect(page.getByTestId("load-error")).toHaveCount(0);

  await failGets(page, "/v1/documents/visit-reminders/versions/1/section-states");
  await page.reload();
  await expect(page.getByTestId("load-error").filter({ visible: true })).toContainText("Could not load the sections' review states.");
  await expect(doc.locator("h2, h3").first()).toBeVisible();
});

test("Simple: a whole PRD that could not be read says so under the one-pager", async ({ page }) => {
  await page.context().addInitScript(() => localStorage.setItem("po-mock-scenario", "prd-calm-page"));
  await login(page);
  await page.goto("/simple/one-pagers/guided-setup");
  await expect(page.getByTestId("prd-whole").getByRole("heading", { level: 2, name: "The whole PRD" })).toBeVisible();
  const path = await calledPath(page, /^\/v1\/documents\/guided-setup\/versions\/\d+$/);

  await failGets(page, path);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Guided setup" })).toBeVisible();
  await expect(page.getByTestId("prd-whole").getByTestId("load-error")).toContainText("Could not load the whole PRD.");
});
