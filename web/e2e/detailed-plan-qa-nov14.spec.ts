import { expect, test, type Page } from "./test";

import { GROUND_TRUTH_SHARED_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/*
 * Visual QA of Nov 14 (Detailed Home, Ground Truth, Plan > Outcomes), against the mock: every feature the
 * Ground Truth pages name reads its code with its name, standing caveats sit behind an (i), and Save
 * prediction says why it waits. Invented example data only.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it rejects), no_claim
 * (what green does not prove).
 */

const PHONE = { width: 390, height: 844 };

async function scenario(page: Page, name: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
}

for (const size of ["desktop", "phone"] as const) {
  test(`Ground Truth's feature list, Running today and Still to build name each feature with its code (${size})`, async ({ page }) => {
    // protects=the Ground Truth tab's rows, Running today's table and its Still to build chips read "F-110
    // Annual plan offer", "F-06 Weekly alert digest"; fails_when=they read the name alone; no_claim=features with no Ground Truth code (they keep the name).
    if (size === "phone") await page.setViewportSize(PHONE);
    await login(page);
    await page.goto("/ground-truth");
    const list = page.getByTestId("cs-desired");
    await list.getByRole("button", { name: /more$/ }).click();
    await expect(list.getByTestId("cs-desired-row").filter({ hasText: "Annual plan offer" })).toContainText("F-110 Annual plan offer");
    await expect(list.getByTestId("cs-desired-row").filter({ hasText: "Setup checklist" })).not.toContainText(/F-\d/);
    await page.getByTestId("cs-tabs").getByRole("tab", { name: /Running today/ }).click();
    await expect(page.getByTestId("cs1-row").filter({ hasText: "Weekly alert digest" })).toContainText("F-06 Weekly alert digest");
    await expect(page.getByTestId("cs-still-chip").filter({ hasText: "Annual plan offer" })).toContainText("F-110 Annual plan offer");
  });
}

test("the feature drawer's Depends on and Blocked by name each feature with its code", async ({ page }) => {
  // protects=Saved carts' drawer reads F-85 Team invites and F-82 Guided setup; fails_when=the names show
  // without codes; no_claim=the links' edits (baseline-links).
  await login(page);
  await page.goto("/ground-truth");
  await page.getByTestId("feature-F-84").getByRole("button", { name: /Saved carts/ }).click();
  const d = page.getByRole("dialog", { name: "Saved carts" });
  const deps = d.getByRole("list", { name: "Depends on" });
  await expect(deps.getByTestId("code-tag")).toHaveText("F-85");
  await expect(deps).toContainText("Team invites");
  await expect(d.getByRole("list", { name: "Blocked by" }).getByTestId("code-tag")).toHaveText("F-82");
});

test("Items: Flagged features, Conflicts and Proposals name each feature with its code", async ({ page }) => {
  // protects=F-81 Dark mode, F-84 Saved carts in the Flagged table, the conflict's heading and the proposal's
  // sentence; Usage export (only proposed) keeps no code; fails_when=the names show alone; no_claim=goals.
  await login(page);
  await page.goto("/ground-truth");
  await page.getByRole("tab", { name: /Items/ }).click();
  await page.getByRole("tab", { name: /Flagged items/ }).click();
  await expect(page.getByRole("button", { name: "F-81 Dark mode", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "F-84 Saved carts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Usage export", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Conflicts/ }).click();
  await expect(page.getByRole("list", { name: "Conflicts" })).toContainText("F-84 Saved carts");
  await page.getByRole("tab", { name: /Proposals/ }).click();
  await expect(page.getByTestId("proposal-summary").filter({ hasText: "delivery status" })).toContainText("Set F-81 Dark mode");
});

test("Proposals: the lock rule is on Accept, not a paragraph", async ({ page }) => {
  // protects=no standing paragraph above the proposals; Accept still says it locks; fails_when=the sentence
  // shows as prose; no_claim=what Accept writes (baseline-accept-locks).
  await login(page);
  await page.goto("/ground-truth?tab=proposals");
  await expect(page.getByTestId("proposal").first()).toBeVisible();
  await expect(page.getByText(/locked against Oracle's changes/).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("proposal").first().getByRole("button", { name: "Accept" })).toHaveAttribute("title", /locked against Oracle's changes/);
});

async function flagList(page: Page) {
  await page.goto("/baseline");
  await page.getByTestId("gt-count-unlinked_item").click();
  const list = page.getByTestId("gt-list-unlinked_item");
  await expect(list).toBeVisible();
  return (name: string) => list.getByTestId("gt-row").filter({ has: page.getByRole("button", { name: `About ${name}`, exact: true }) });
}

test("a flag row's (i) opens into the page, not over the rail", async ({ page }) => {
  // protects=the (i) beside Chat alerts opens right of the rail at 1440; fails_when=the tip covers the
  // rail; no_claim=the tip's words.
  await page.setViewportSize({ width: 1440, height: 900 });
  await scenario(page, GROUND_TRUTH_SHARED_SCENARIO);
  await login(page, "approver@example.com");
  const row = await flagList(page);
  await row("Chat alerts").getByRole("button", { name: "About Chat alerts", exact: true }).click();
  const tip = page.getByRole("tooltip").filter({ visible: true });
  await expect(tip).toBeVisible();
  const main = (await page.locator("main").boundingBox())!;
  expect((await tip.boundingBox())!.x).toBeGreaterThanOrEqual(main.x);
});

test("the Linked notice names the feature with its code", async ({ page }) => {
  // protects=Linked "Forum alerts" to "F-1xx Community alerts"; fails_when=the notice names the feature
  // alone; no_claim=the link's write (ground-truth-own-feature-items).
  await scenario(page, GROUND_TRUTH_SHARED_SCENARIO);
  await login(page, "approver@example.com");
  let row = await flagList(page);
  await row("Chat alerts").getByRole("button", { name: /Confirm it/ }).click();
  await expect(page.getByTestId("gt-notice")).toContainText("Confirmed “Community alerts”");
  await row("Forum alerts").getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByTestId("gt-own-feature").click();
  await expect(page.getByTestId("gt-notice")).toContainText("Added “Forum alerts” to the Ground Truth");
  await signOut(page);
  await login(page);
  await page.goto("/simple");
  await page.getByTestId("home-proposal").filter({ hasText: "Forum alerts" }).getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("home-proposal").filter({ hasText: "Forum alerts" })).toHaveCount(0);
  row = await flagList(page);
  await row("Forum alerts").getByRole("button", { name: /Link to a feature/ }).click();
  await page.getByTestId("gt-picker").getByRole("button").filter({ hasText: "Community alerts" }).click();
  await expect(page.getByTestId("gt-notice")).toContainText(/Linked “Forum alerts” to “F-\d+ Community alerts”/);
});

test("Simple Home's dates to confirm flag an item with no code", async ({ page }) => {
  // protects=a roadmap item with no code carries "Not in the Ground Truth", one with a code reads it;
  // fails_when=the name shows bare; no_claim=items not on the roadmap.
  await scenario(page, GROUND_TRUTH_SHARED_SCENARIO);
  await login(page);
  await page.goto("/simple");
  const item = (name: string) => page.getByTestId("waiting-item").filter({ hasText: name }).first();
  await expect(item("Alert routing by team").getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
  await expect(item("F-03 Health log")).toBeVisible();
  await expect(item("F-03 Health log").getByTestId("not-in-gt")).toHaveCount(0);
});

async function outcomes(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes-long"));
  await login(page);
  await page.goto("/plan/outcomes");
  await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();
}
const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });

test("Oracle's reading keeps its caveat behind the (i)", async ({ page }) => {
  // protects=the caveat shows only in the (i); fails_when=it is a standing line under the reading;
  // no_claim=the reading's numbers.
  await outcomes(page);
  await page.getByTestId("outcome-row").filter({ hasText: "Retry failed card payments overnight" }).click();
  await expect(inspector(page).getByTestId("outcome-proposal")).toBeVisible();
  await expect(page.getByText(/does not prove the item caused it/).filter({ visible: true })).toHaveCount(0);
  await inspector(page).getByRole("button", { name: "About How Oracle reads the actual" }).click();
  await expect(page.getByText(/does not prove the item caused it/).filter({ visible: true })).toBeVisible();
});

test("Save prediction waits for a predicted value", async ({ page }) => {
  // protects=Save prediction is off, with its reason, while Predicted is empty; fails_when=Save is on and
  // does nothing; no_claim=what Save writes (outcomes-long-titles).
  await outcomes(page);
  await page.getByTestId("outcome-row").filter({ hasText: "Let a team admin export every invoice" }).click();
  const form = inspector(page).getByTestId("prediction-form");
  const save = form.getByRole("button", { name: "Save prediction" });
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", "Add a predicted value first");
  await form.getByLabel("Predicted").fill("12");
  await expect(save).toBeEnabled();
});
