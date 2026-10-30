import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 4, shell lane: a new company's first run (the mock's "empty" scenario, its data
 * reset), walked through the UI from the rail as a person would.
 *
 * protects = qa-shell-9 (an empty PRDs, Runs, Baseline, Inbox or Simple Decisions says what
 * comes next, and only offers what the role can do; Decisions says "No decisions yet" when no
 * filter is set), qa-shell-10 (one New request on an empty Requests), qa-shell-30 (Baseline's
 * counts read "No goals yet" and "No features yet", never 0/0).
 * no_claim = the API's lists (the in-browser mock stands in).
 */

const PHONE = { width: 390, height: 844 };

/** A new company: the "empty" scenario, its mock data reset once (not on every page load). */
async function emptyCompany(page: Page) {
  await page.goto("/icon.svg");
  await page.evaluate(() => {
    localStorage.removeItem("po-mock-db-v2");
    localStorage.setItem("po-mock-scenario", "empty");
  });
}

/** From the rail, as a person gets there. */
async function open(page: Page, nav: string, heading: string) {
  await page.getByTestId(nav).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

test("qa-shell-9, 10, 30: the owner of a new company walks every empty page and files a first request", async ({ page }) => {
  await emptyCompany(page);
  await login(page);

  // Inbox: what will arrive, not only that nothing is here.
  await open(page, "nav-inbox", "Inbox");
  await expect(page.getByTestId("inbox-tab-empty")).toContainText(
    "Nothing needs you yet. Decisions, approvals and questions for you will show up here.",
  );

  // PRDs: the next step, with the button the owner has.
  await open(page, "nav-prds", "PRDs");
  await expect(page.getByTestId("prds-empty")).toHaveText("No PRDs yet. Start one with New PRD.");
  await expect(page.getByRole("link", { name: "New PRD" }).filter({ visible: true })).toHaveCount(1);

  // Runs.
  await open(page, "nav-runs", "Runs");
  // Runs' own words (fix4-work): its header's button is Start a run….
  await expect(page.getByTestId("runs-empty")).toContainText("No runs yet. Start one from Start a run… or from the page it works on.");
  await expect(page.getByRole("button", { name: "Start a run…" })).toBeVisible();

  // Baseline: no 0/0 counts, and each empty table says how to fill it.
  await open(page, "nav-baseline", "Baseline");
  await expect(page.getByTestId("kpi-goals")).toContainText("No goals yet");
  await expect(page.getByTestId("kpi-traced")).toContainText("No features yet");
  await expect(page.locator('dl[aria-label="Counts"]')).not.toContainText("0/0");
  await expect(page.getByTestId("confirmed-chip")).toHaveCount(0);
  await expect(page.getByTestId("table-empty").filter({ visible: true })).toHaveText("No goals yet. Add one, or draft them from your sources with Build baseline.");
  await expect(page.getByTestId("features-empty")).toHaveText("No features yet. Add one, or draft them from your sources with Build baseline.");
  await expect(page.getByRole("button", { name: "Build baseline" })).toBeVisible();

  // Simple's Decisions: nothing is filtered, so "No decisions yet", never "No decision matches".
  await page.goto("/simple/decisions");
  const decisions = page.getByTestId("decisions-empty").filter({ visible: true });
  await expect(decisions).toContainText("No decisions yet.");
  await expect(decisions).not.toContainText("No decision matches");
  await expect(decisions.getByRole("link", { name: "Meetings" })).toBeVisible();

  // Requests: one New request, the header's; the empty state points to it.
  await page.goto("/home");
  await open(page, "nav-requests", "Requests");
  await expect(page.getByTestId("requests-empty")).toHaveText("No requests yet. Add one with New request.");
  await expect(page.getByRole("button", { name: "New request", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "New request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New request" });
  await dialog.getByLabel("Title").fill("Export invoices as CSV");
  await dialog.getByLabel("What it is and why").fill("Finance retypes every invoice into the ledger each month.");
  await dialog.getByRole("button", { name: "File request" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("request-row").filter({ hasText: "Export invoices as CSV" })).toBeVisible();
  await expect(page.getByTestId("requests-empty")).toHaveCount(0);
});

test("qa-shell-9: a viewer's empty pages offer nothing they cannot do", async ({ page }) => {
  await emptyCompany(page);
  await login(page, "viewer@example.com");

  await open(page, "nav-prds", "PRDs");
  await expect(page.getByTestId("prds-empty")).toHaveText("No PRDs yet. They appear here once someone starts one.");
  await expect(page.getByRole("link", { name: "New PRD" })).toHaveCount(0);

  await open(page, "nav-runs", "Runs");
  await expect(page.getByTestId("runs-empty")).toContainText("No runs yet. Runs show here once an approver starts one.");
  await expect(page.getByRole("button", { name: "Start a run…" })).toHaveCount(0);

  await open(page, "nav-baseline", "Baseline");
  await expect(page.getByTestId("kpi-goals")).toContainText("No goals yet");
  await expect(page.getByTestId("table-empty").filter({ visible: true })).toHaveText("No goals yet. They appear here once someone adds one.");
  await expect(page.getByTestId("features-empty")).toHaveText("No features yet. They appear here once someone adds one.");

  await open(page, "nav-requests", "Requests");
  await expect(page.getByTestId("requests-empty")).toHaveText("No requests yet. They appear here once someone files one.");
  await expect(page.getByRole("button", { name: "New request", exact: true })).toHaveCount(0);
});

test("qa-shell-30: on a phone the Baseline's counts say No goals yet in full", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await emptyCompany(page);
  await login(page);
  await page.goto("/baseline");
  await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
  for (const [id, text] of [
    ["kpi-goals", "No goals yet"],
    ["kpi-traced", "No features yet"],
  ] as const) {
    const cell = page.getByTestId(id);
    await expect(cell).toContainText(text);
    // Nothing cut: the value fits inside its cell.
    expect(await cell.locator("dd").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
