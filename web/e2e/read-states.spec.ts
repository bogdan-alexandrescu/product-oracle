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

/** Waits until the mock has answered a GET whose path and query start with `call`. */
async function answered(page: Page, call: string) {
  await page.waitForFunction((c) => ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ?? []).some((l) => l.startsWith(`GET ${c}`)), call);
  // The mock's latency, then a render.
  await page.waitForTimeout(800);
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
    await answered(page, "/v1/documents?kind=prd");
    await expect(page.getByRole("table", { name: "PRDs" })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("prds-empty")).toHaveCount(0);
    await expect(page.getByTestId("prds-empty")).toBeVisible({ timeout: 15_000 });
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
