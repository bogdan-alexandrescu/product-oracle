import { expect, test, type Locator, type Page } from "./test";

import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRun, seedSentBack } from "./helpers";

/*
 * fix4 QA on a run's page, /runs/<id> (qa-work-4, 5, 16, 18, 19, 20, 21, 22, 23, 27, 45),
 * driven through the UI on the mock's default scenario (cld-7 is in e2e/page-header.spec.ts).
 */

const header = (page: Page) => page.locator("header[data-page-header]").filter({ visible: true });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Run" }).filter({ visible: true });

/** Opens the run on `document` from the Runs list, as a person would. */
async function openRun(page: Page, document: string, email?: string) {
  await login(page, email);
  await page.goto("/runs");
  await page.locator(`[data-testid="run-row"][data-document="${document}"]`).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByTestId("segment-timeline")).toBeVisible();
}

const box = async (l: Locator) => (await l.boundingBox())!;

test("qa-work-4: a run paused over budget names its estimate and limit together, in the banner and the panel", async ({ page }) => {
  await openRun(page, "team-workspaces");
  await expect(page.getByTestId("run-overrun-held")).toHaveText(
    "Spent $14.20, past its limit. Estimate $9.00, limit $13.50 (150%). The PRD review is held until you resume it. Resuming lets it spend up to $18.70 in total, $4.50 more. Cancel run stops it.",
  );
  const section = inspector(page).getByTestId("run-cost-section");
  await expect(section.locator('[data-cost="prominent"]')).toHaveText("$14.20 of $9.00 estimated");
  await expect(section.getByTestId("run-overrun-limit")).toHaveText("Estimate $9.00, limit $13.50 (150%)");
});

test("qa-work-5: a paused run does not read as done; its held PRD review says Held: over budget", async ({ page }) => {
  await openRun(page, "team-workspaces");
  const done = page.getByTestId("segments-done");
  await expect(done).toContainText("Paused");
  await expect(done).not.toHaveText(/^\d+ of \d+ done$/);
  const held = page.getByTestId("segment-checkpoint").first();
  await expect(held).toHaveText(/Held: over budget/);
  await expect(held).toHaveAttribute("data-kind", "warn");
  await expect(held).toHaveAttribute("title", /PRD review is held/);
});

test("qa-work-16: an items check with no problems says No problems, capitalised", async ({ page }) => {
  await login(page);
  const seed = JSON.parse(JSON.stringify(ROADMAP_REVIEW_RUN).replaceAll("0000000d2", "00000f1d2")) as typeof ROADMAP_REVIEW_RUN;
  const [items] = seed.run.segments;
  items.items_check = { ...items.items_check!, problems: [], reasons: [], blocking: 0, to_confirm: 0 };
  const id = await seedRun(page, seed);
  await page.goto(`/runs/${id}`);
  const check = page.getByTestId("segment-roadmap_items").getByTestId("items-check");
  await expect(check.getByText("No problems", { exact: true })).toBeVisible();
  await expect(page.getByText("no problems", { exact: true })).toHaveCount(0);
});

test("qa-work-18, 19: a finished run names its import by the document's title, its file as a raw file", async ({ page }) => {
  await openRun(page, "checkout-redesign");
  const segment = page.getByTestId("segment-timeline").locator("li").filter({ hasText: "Imported as" }).first();
  await expect(segment.getByRole("link", { name: "Checkout redesign PRD v2" })).toBeVisible();
  await expect(segment).not.toContainText("checkout-redesign v2");
  const files = segment.getByRole("group", { name: "Raw file" });
  await expect(files.getByTestId("artifacts-raw-label")).toHaveText("Raw file:");
  await files.getByRole("button", { name: "PRD draft" }).click();
  await expect(segment.getByTestId("artifact-content")).toBeVisible();
});

test("qa-work-20: the run's document reads For <document> on a document that exists and one the run writes", async ({ page }) => {
  await openRun(page, "team-workspaces");
  const doc = header(page).getByTestId("run-document");
  await expect(doc).toHaveText("Team workspaces PRD");
  await expect(doc.locator("xpath=..")).toHaveText(/^For\s*Team workspaces PRD$/);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="usage-alerts-v2"]').getByRole("link").first().click();
  const written = header(page).getByTestId("run-document");
  await expect(written).toHaveText("Usage alerts v2 PRD (written by this run)");
  await expect(written.locator("xpath=..")).toHaveText(/^For\s*Usage alerts v2 PRD \(written by this run\)$/);
  // Dark and medium weight, as the linked one: not grey.
  const [a, b] = await Promise.all([written, header(page).getByTestId("run-decision-log")].map((l) => l.evaluate((el) => getComputedStyle(el).fontWeight)));
  expect(a).toBe(b);
});

test("qa-work-21, 23: pending checkpoints are plain text, role chips one style, the Cost value like every other", async ({ page }) => {
  await openRun(page, "team-onboarding");
  const pending = page.getByTestId("segment-checkpoint").filter({ hasNotText: /checkpoint (off|skipped)/ });
  await expect(pending.first()).toBeVisible();
  for (const el of await pending.all()) {
    await expect(el).not.toHaveAttribute("data-kind", /.+/);
    await expect(el).toHaveCSS("border-top-width", "0px");
  }
  const roles = page.getByTestId("segment-role");
  await expect(roles.first()).toBeVisible();
  const kinds = new Set(await roles.evaluateAll((els) => els.map((el) => el.getAttribute("data-kind"))));
  expect([...kinds]).toEqual(["na"]);
  // qa-work-23: the Cost value's weight and colour are its row's, as every Details value.
  const cost = inspector(page).getByTestId("run-details").getByTestId("run-cost");
  const [mine, row] = await cost.evaluate((el) => [el, el.parentElement!].map((x) => `${getComputedStyle(x).fontWeight} ${getComputedStyle(x).color}`));
  expect(mine).toBe(row);
});

test("qa-work-22: the actions stay on the title's line on every run, the cost approval's too", async ({ page }) => {
  await login(page);
  for (const doc of ["team-onboarding", "usage-alerts-v2", "team-workspaces"]) {
    // Signed in once: each run from the Runs list.
    await page.goto("/runs");
    await page.locator(`[data-testid="run-row"][data-document="${doc}"]`).getByRole("link").first().click();
    await expect(page.getByTestId("segment-timeline")).toBeVisible();
    const h1 = await box(header(page).getByRole("heading", { level: 1 }));
    const action = await box(header(page).getByRole("button", { name: "Cancel run" }));
    const mid = action.y + action.height / 2;
    expect(mid, `${doc}: Cancel run is on the title's line`).toBeGreaterThanOrEqual(h1.y);
    expect(mid, `${doc}: Cancel run is on the title's line`).toBeLessThanOrEqual(h1.y + h1.height);
    const status = await box(header(page).getByTestId("run-status"));
    expect(status.y, `${doc}: the status is under the title`).toBeGreaterThanOrEqual(h1.y + h1.height - 1);
  }
});

test("qa-work-27: a viewer at a checkpoint is told who decides and that they can only read it", async ({ page }) => {
  await openRun(page, "team-onboarding", "viewer@example.com");
  const shared = page.getByTestId("shared-draft");
  await expect(shared).toContainText("Confirm the baseline: waiting for a decision");
  await expect(shared.getByTestId("checkpoint-who")).toHaveText("Approvers and owners can decide");
  await expect(shared).toContainText("You can read it; you can't decide it.");
  await expect(shared).not.toContainText("shared decision");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-work-20: no separator dangles at a line's end on a phone", async ({ page }) => {
    await openRun(page, "usage-alerts-v2");
    await expect(page.getByTestId("run-decision-log").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("run-header-sep").filter({ visible: true })).toHaveCount(0);
  });

  test("qa-work-45: the baseline link stays inside the checkpoint card; the attempt chip sits under the name", async ({ page }) => {
    await openRun(page, "team-onboarding");
    const card = page.locator("#decide");
    const link = card.getByTestId("from-run-link");
    await expect(link).toBeVisible();
    const c = await box(card);
    const l = await box(link);
    // The card's 12 px padding stays on the right.
    expect(l.x + l.width).toBeLessThanOrEqual(c.x + c.width - 12 + 0.5);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);

    const id = await seedSentBack(page);
    await page.goto(`/runs/${id}`);
    const prd = page.getByTestId("segment-prd_draft");
    const title = await box(prd.getByTestId("segment-title"));
    const chip = await box(prd.getByTestId("segment-attempt"));
    expect(chip.y).toBeGreaterThanOrEqual(title.y + title.height - 0.5);
  });
});
