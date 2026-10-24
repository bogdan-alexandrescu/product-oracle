import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

import { login } from "./helpers";

/**
 * A1 First-run path: a new company's owner sets Oracle up from the Set up checklist on Home,
 * through the UI only. An owner has seven steps, A3's Engineering lead and B1's Build
 * baseline among them (the default company's baseline was built before).
 *
 * no_claim for every test here: the in-browser mock's /v1/setup stands in for the API's
 * (api/tests/test_setup.py covers the API's step rules); the mock's connections and sources
 * stores are the company's, not per person.
 */

const panel = (page: Page) => page.getByTestId("home-setup");
const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);

async function newCompany(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
}

/** Connects Slack with a pasted token on Settings > Connections, as a person would. */
async function connectSlack(page: Page) {
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByText("Connected")).toBeVisible();
}

async function backToHome(page: Page) {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function connectFromSetup(page: Page) {
  await row(page, "connect").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/connections\?from=setup$/);
  await connectSlack(page);
  await backToHome(page);
}

/** A3: names the approver engineering lead from the checklist's Engineering lead step. */
async function nameLeadFromSetup(page: Page) {
  await row(page, "eng_lead").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/members\?from=setup#engineering-lead$/);
  const box = page.getByRole("checkbox", { name: "Engineering lead: approver@example.com" });
  await box.check();
  await expect(box).toBeChecked();
  await backToHome(page);
}

/** H2: saves the Company time zone (Los Angeles, the default) from the checklist's Time zone step. */
async function setZoneFromSetup(page: Page) {
  await row(page, "timezone").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=setup#timezone$/);
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await backToHome(page);
}

async function confirmHorizonsFromSetup(page: Page) {
  await row(page, "horizons").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=setup#horizons$/);
  await page.locator("#horizons").getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("#horizons").getByRole("button", { name: "Reset" })).toBeVisible();
  await backToHome(page);
}

test("setup: a new company's owner sees the checklist with what is already done", async ({ page }) => {
  // protects=the owner's first-run checklist on Home; fails_when=a step is missing, in the
  // wrong order or reads the wrong state; no_claim=the API's /v1/setup (mock stands in).
  await newCompany(page);
  await login(page);
  await expect(panel(page).getByRole("heading", { name: "Set up" })).toBeVisible();
  await expect(panel(page).getByTestId("panel-count")).toHaveText("2 of 8");
  const keys = await panel(page).locator("[data-testid^='setup-row-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(keys).toEqual(["setup-row-connect", "setup-row-sources", "setup-row-invite", "setup-row-domains", "setup-row-eng_lead", "setup-row-horizons", "setup-row-timezone", "setup-row-build_baseline"]);
  await expect(row(page, "invite")).toHaveAttribute("data-done", "true");
  await expect(row(page, "invite").getByTestId("setup-status")).toHaveText("4 people");
  await expect(row(page, "domains")).toHaveAttribute("data-done", "true");
  await expect(row(page, "domains").getByTestId("setup-status")).toHaveText("example.com");
  for (const [key, status] of [
    ["connect", "None"],
    ["sources", "None"],
    ["eng_lead", "None"],
    ["horizons", "Not checked"],
    // #514: an unset zone says which one is used meanwhile.
    ["timezone", "Not set · Pacific is used"],
    ["build_baseline", "Not built"],
  ]) {
    await expect(row(page, key)).toHaveAttribute("data-done", "false");
    await expect(row(page, key).getByTestId("setup-status")).toHaveText(status);
  }
  // The panel is the first in the left column, above Goals.
  const setupBox = await panel(page).boundingBox();
  const goalsBox = await page.getByTestId("home-goals").boundingBox();
  expect(setupBox!.y + setupBox!.height).toBeLessThanOrEqual(goalsBox!.y);
});

test("setup: Connect tools opens Connections and Back to Home shows it done", async ({ page }) => {
  // protects=the way there and back from a step; fails_when=Open loses ?from=setup, Back to
  // Home is missing, or the step stays open after connecting; no_claim=the provider check.
  await newCompany(page);
  await login(page);
  await row(page, "connect").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/connections\?from=setup$/);
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" })).toBeVisible();
  await connectSlack(page);
  await backToHome(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText("3 of 8");
  await expect(row(page, "connect")).toHaveAttribute("data-done", "true");
  await expect(row(page, "connect").getByTestId("setup-status")).toHaveText("1 connected");
  // Another settings tab drops the way back.
  await row(page, "connect").getByRole("link", { name: "Open" }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByTestId("nav-members").click();
  await expect(page).toHaveURL(/\/settings\/members$/);
  await expect(page.getByRole("link", { name: "Back to Home" })).toHaveCount(0);
});

test("setup: Horizons opens the Company page with the defaults and Confirm ticks it", async ({ page }) => {
  // protects=checking the horizons from the checklist; fails_when=the page shows other
  // defaults, Confirm stores nothing, or the step stays open; no_claim=the API's validation.
  await newCompany(page);
  await login(page);
  await row(page, "horizons").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=setup#horizons$/);
  const horizons = page.locator("#horizons");
  await expect(horizons.getByLabel("Now")).toHaveValue("1");
  await expect(horizons.getByLabel("Now").locator("option:checked")).toHaveText("Current quarter");
  await expect(horizons.getByLabel("Next").locator("option:checked")).toHaveText("Next 2 quarters");
  await expect(horizons.getByLabel("From")).toHaveValue("12");
  await expect(horizons.getByLabel("To")).toHaveValue("24");
  await expect(horizons.getByRole("button", { name: "Reset" })).toHaveCount(0);
  await horizons.getByRole("button", { name: "Confirm" }).click();
  await expect(horizons.getByRole("button", { name: "Reset" })).toBeVisible();
  await backToHome(page);
  await expect(row(page, "horizons")).toHaveAttribute("data-done", "true");
  await expect(row(page, "horizons").getByTestId("setup-status")).toHaveText("Checked");
  await expect(panel(page).getByTestId("panel-count")).toHaveText("3 of 8");
});

test("setup: a change shows Save, a bad span shows the error, Reset reopens the step", async ({ page }) => {
  // protects=changing and resetting the horizons; fails_when=Save is not offered after a
  // change, a bad span is stored, or Reset leaves the step done; no_claim=runs read them.
  await newCompany(page);
  await login(page);
  await confirmHorizonsFromSetup(page);
  await row(page, "horizons").getByRole("link", { name: "Open" }).click();
  const horizons = page.locator("#horizons");
  await expect(horizons.getByRole("button", { name: "Save" })).toHaveCount(0);
  await horizons.getByLabel("From").fill("6");
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("alert")).toContainText("long_from_months must start after Next ends (at least 9 months)");
  await horizons.getByLabel("From").fill("18");
  await horizons.getByLabel("To").fill("30");
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("alert")).toHaveCount(0);
  await expect(horizons.getByRole("button", { name: "Save" })).toHaveCount(0);
  await horizons.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reset" }).click();
  await expect(horizons.getByLabel("From")).toHaveValue("12");
  await expect(horizons.getByRole("button", { name: "Confirm" })).toBeVisible();
  await backToHome(page);
  await expect(row(page, "horizons")).toHaveAttribute("data-done", "false");
});

test("setup: with Now on two quarters, Next still reads as the next quarters", async ({ page }) => {
  // protects=criterion 9's wording on screen (owner, 2026-10-21): Next reads "Next N
  // quarters" whatever Now covers, as the roadmap prompt does; fails_when=the saved choice
  // is lost or Next is worded from Now; no_claim=the prompt text (api/tests/test_roadmap.py).
  await newCompany(page);
  await login(page);
  await row(page, "horizons").getByRole("link", { name: "Open" }).click();
  const horizons = page.locator("#horizons");
  await horizons.getByLabel("Now").selectOption({ label: "Current and next quarter" });
  await horizons.getByLabel("Next").selectOption({ label: "Next 2 quarters" });
  await horizons.getByLabel("From").fill("18");
  await horizons.getByLabel("To").fill("30");
  await horizons.getByRole("button", { name: "Save" }).click();
  await expect(horizons.getByRole("button", { name: "Reset" })).toBeVisible();
  await page.reload();
  await expect(horizons.getByLabel("Now").locator("option:checked")).toHaveText("Current and next quarter");
  await expect(horizons.getByLabel("Next").locator("option:checked")).toHaveText("Next 2 quarters");
  await expect(horizons.getByLabel("From")).toHaveValue("18");
  await expect(horizons.getByLabel("To")).toHaveValue("30");
  await backToHome(page);
  await expect(row(page, "horizons")).toHaveAttribute("data-done", "true");
});

test("setup: Hide puts the checklist behind a header chip, and a reload keeps the choice", async ({ page }) => {
  // protects=hiding and showing the checklist again; fails_when=Hide does not stick, the
  // chip is missing or miscounts, or a reload forgets; no_claim=other people's choice.
  await newCompany(page);
  await login(page);
  await connectFromSetup(page);
  await confirmHorizonsFromSetup(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText("4 of 8");
  await panel(page).getByRole("button", { name: "Hide" }).click();
  await expect(panel(page)).toHaveCount(0);
  const chip = page.getByRole("button", { name: "Set up 4/8" });
  await expect(chip).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Set up 4/8" })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Set up 4/8" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up 4/8" })).toHaveCount(0);
  await page.reload();
  await expect(panel(page).getByTestId("panel-count")).toHaveText("4 of 8");
});

test("setup: commenters see their own two steps", async ({ page }) => {
  // protects=a commenter's personal steps; fails_when=a commenter sees owner steps;
  // no_claim=approvers (same rule as commenters).
  await newCompany(page);
  await login(page, "commenter@example.com");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("[data-testid^='setup-row-']")).toHaveCount(2);
  await expect(row(page, "connect")).toBeVisible();
  await expect(row(page, "sources")).toBeVisible();
  await expect(panel(page).getByTestId("panel-count")).toHaveText("0 of 2");
});

test("setup: viewers get no checklist", async ({ page }) => {
  // protects=viewers, who cannot add sources, see no setup; fails_when=the panel or the
  // chip draws for a viewer; no_claim=the viewer's other Home blocks.
  await newCompany(page);
  await login(page, "viewer@example.com");
  await expect(page.getByTestId("home-needs")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Set up/ })).toHaveCount(0);
});

test("setup: with every step done the checklist is not drawn", async ({ page }) => {
  // protects=a finished setup leaves Home alone; fails_when=the panel or the chip still
  // draws; no_claim=a step going back to open later (covered by the Reset test).
  await login(page);
  // The default company's baseline was built before: invite, domains and Build baseline done.
  await expect(panel(page).getByTestId("panel-count")).toHaveText("4 of 8");
  await connectFromSetup(page);
  await nameLeadFromSetup(page);
  await confirmHorizonsFromSetup(page);
  await setZoneFromSetup(page);
  await expect(page.getByTestId("home-needs")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Set up/ })).toHaveCount(0);
});

test("setup: on a phone each row keeps one line and nothing scrolls sideways", async ({ page }) => {
  // protects=the checklist at 390 px; fails_when=the page scrolls sideways or an Open link
  // is cut off; no_claim=other phone widths.
  await page.setViewportSize({ width: 390, height: 844 });
  await newCompany(page);
  await login(page);
  await expect(panel(page)).toBeVisible();
  const opens = panel(page).getByRole("link", { name: "Open" });
  await expect(opens).toHaveCount(8);
  for (const link of await opens.all()) {
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const r of await panel(page).locator("[data-testid^='setup-row-']").all()) {
    const box = (await r.boundingBox())!;
    expect(box.height).toBeLessThan(64);
  }
});

test("setup: a non-owner on Settings > Company sees it is not for their role, and no inputs", async ({ page }) => {
  // protects=company settings stay the owner's in the UI; fails_when=a commenter gets
  // controls; no_claim=the API's owner check (test_tenant_settings_api covers it).
  await login(page, "commenter@example.com");
  await page.goto("/settings/company");
  await expect(page.getByTestId("not-for-role")).toContainText("Not available for your role");
  const main = page.getByRole("main");
  await expect(main.getByRole("combobox")).toHaveCount(0);
  await expect(main.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.locator("#horizons")).toHaveCount(0);
});

test("setup: a step this build has no words for is still listed", async ({ page }) => {
  // protects=H2 review (minor): every step /v1/setup returns has a row, so the rows add up
  // to the panel's count; fails_when=a step the web has no label for is skipped silently
  // (the count says 9 and 8 rows show); no_claim=the API's steps (the mock's
  // "setup-new-step" scenario stands in for an API with a step this build predates).
  await page.addInitScript((key) => localStorage.setItem(key, "setup-new-step"), MOCK_SCENARIO_KEY);
  await login(page);
  await expect(panel(page).getByTestId("panel-count")).toHaveText(/^\d+ of 9$/);
  await expect(panel(page).locator("[data-testid^='setup-row-']")).toHaveCount(9);
  const fresh = row(page, "calendar");
  await expect(fresh).toHaveAttribute("data-done", "false");
  await expect(fresh).toContainText("Calendar");
  await expect(fresh.getByTestId("setup-status")).toHaveText("Not done");
});
