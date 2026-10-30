import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * qa-onboarding-44: a new company's owner walks Home's whole Set up checklist, from "2 of 8"
 * to done, through the UI only: each step from its row's Open, back with Settings' Back to
 * Home, and the baseline built, reviewed and approved from the run the row opens.
 *
 * no_claim for the test here: the in-browser mock's /v1/setup, sources and runs stand in for
 * the API and SwarmCloud (api/tests/test_setup.py covers the API's step rules); the mock's
 * agents finish a segment on "Refresh progress".
 */

const panel = (page: Page) => page.getByTestId("home-setup");
const row = (page: Page, key: string) => page.getByTestId(`setup-row-${key}`);
const count = (page: Page) => panel(page).getByTestId("panel-count");

async function openStep(page: Page, key: string, url: RegExp) {
  const action = row(page, key).getByTestId("setup-action");
  await expect(action).toHaveText("Open");
  await action.click();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" })).toBeVisible();
}

async function backToHome(page: Page) {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/** A step reads done, with its status and a Change button, and the panel counts it. */
async function seeDone(page: Page, key: string, status: string | RegExp, done: number) {
  await expect(row(page, key)).toHaveAttribute("data-done", "true");
  await expect(row(page, key).getByTestId("setup-status")).toHaveText(status);
  await expect(row(page, key).getByTestId("setup-action")).toHaveText("Change");
  await expect(count(page)).toHaveText(`${done} of 8`);
}

test("qa2 onboarding: the owner of a new company walks Set up from 2 of 8 to done, and the panel goes", async ({ page }) => {
  // protects=qa-onboarding-44, the whole first-run checklist on Home as a person walks it;
  // fails_when=a step's Open lands elsewhere or loses the way back, a finished step stays open
  // or reads the wrong status, the count is off, the Build baseline row does not follow its
  // run (Building…, Open the build), or the panel or a Set up chip still draws once every
  // step is done; no_claim=the API's /v1/setup and a real SwarmCloud run (mock stands in).
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);

  // A new company: invite and domains done (the team is there), six steps to go.
  await expect(panel(page).getByRole("heading", { name: "Set up" })).toBeVisible();
  await expect(count(page)).toHaveText("2 of 8");
  await expect(row(page, "invite")).toHaveAttribute("data-done", "true");
  // The empty scenario has its four members and no open invite (seedEmpty: invites []).
  await expect(row(page, "invite").getByTestId("setup-status")).toHaveText("4 people");
  await expect(row(page, "domains")).toHaveAttribute("data-done", "true");
  await expect(row(page, "domains").getByTestId("setup-status")).toHaveText("example.com");
  await expect(row(page, "build_baseline").getByTestId("setup-status")).toHaveText("Not built");
  // With no goals and the step on screen, the Goals card points at Set up, no second start.
  const goals = page.getByTestId("home-goals");
  await expect(goals.getByTestId("goals-build-in-setup")).toHaveText("Build it from Set up, above");
  await expect(goals.getByRole("link", { name: "Build the baseline" })).toHaveCount(0);

  // 1. Connect tools: Slack with a pasted token.
  await openStep(page, "connect", /\/settings\/connections\?from=setup$/);
  const slack = page.getByTestId("connection-card-slack");
  await slack.getByRole("button", { name: "Paste a token" }).click();
  await slack.getByLabel("Token", { exact: true }).fill("example-slack-1234");
  await slack.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(slack.getByText("Connected")).toBeVisible();
  await backToHome(page);
  await seeDone(page, "connect", "1 connected", 3);

  // 2. Pick sources: an upload source, which needs no connection.
  await openStep(page, "sources", /\/settings\/sources\?from=setup$/);
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("upload");
  await form.getByLabel("Name").fill("Research notes");
  await form.getByRole("button", { name: "Add source" }).click();
  const notes = page.getByRole("listitem", { name: "Research notes" });
  await expect(notes).toBeVisible();
  // An empty source does not tick the step (qa-onboarding-11): a file in it does.
  await notes.getByLabel("Upload files to Research notes").setInputFiles([
    { name: "interview.md", mimeType: "text/markdown", buffer: Buffer.from("# Interview\nThe export button is hard to find.") },
  ]);
  await expect(notes.getByTestId("source-items")).toHaveText("1 item");
  await backToHome(page);
  await seeDone(page, "sources", "1 source", 4);

  // 3. Engineering lead: the approver.
  await openStep(page, "eng_lead", /\/settings\/members\?from=setup#engineering-lead$/);
  const lead = page.getByRole("checkbox", { name: "Engineering lead: approver@example.com" });
  await lead.check();
  await expect(lead).toBeChecked();
  await backToHome(page);
  await seeDone(page, "eng_lead", "1 lead", 5);

  // 4. Horizons: the defaults, confirmed.
  await openStep(page, "horizons", /\/settings\/company\?from=setup#horizons$/);
  // Settings' panels all say Save; unchanged defaults are confirmed by it (qa-settings-18).
  await page.locator("#horizons").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#horizons").getByRole("button", { name: "Reset" })).toBeVisible();
  await backToHome(page);
  await seeDone(page, "horizons", "Checked", 6);

  // 5. Time zone: Los Angeles (the default), saved.
  await expect(row(page, "timezone").getByTestId("setup-status")).toHaveText("Not set · Pacific is used");
  await openStep(page, "timezone", /\/settings\/company\?from=setup#timezone$/);
  // Save waits for a zone to be picked (fix2-settings: "Not set" never stores Los Angeles).
  await page.getByLabel("Company time zone").selectOption("America/Los_Angeles");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");
  await backToHome(page);
  await seeDone(page, "timezone", /Pacific/, 7);

  // 6. Build baseline: Open lands on the Baseline page's start sheet; Start.
  const build = row(page, "build_baseline");
  await expect(build).toHaveAttribute("data-done", "false");
  await expect(build.getByTestId("setup-action")).toHaveText("Open");
  await build.getByTestId("setup-action").click();
  await expect(page).toHaveURL(/\/baseline\?build=1&from=setup$/);
  const sheet = page.getByRole("dialog", { name: "Build the baseline" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Start" }).click();
  await expect(sheet).toHaveCount(0);
  // The build banner says it, with the Inbox item to come (qa-onboarding-25: one line, not a toast too).
  await expect(page.getByTestId("baseline-build-banner")).toContainText("You'll get an Inbox item when it's ready to review.");

  // Home while it builds: the row says so and opens the run; the Goals card opens it too.
  await page.getByTestId("nav-home").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(count(page)).toHaveText("7 of 8");
  await expect(build).toHaveAttribute("data-done", "false");
  await expect(build.getByTestId("setup-status")).toHaveText("Building…");
  const openBuild = build.getByTestId("setup-action");
  await expect(openBuild).toHaveText("Open the build");
  await expect(openBuild).toHaveAttribute("href", /^\/runs\/[0-9a-f-]+$/);
  const runHref = await openBuild.getAttribute("href");
  await expect(goals.getByTestId("goals-open-build")).toHaveText("Open the build");
  await expect(goals.getByTestId("goals-open-build")).toHaveAttribute("href", runHref!);
  await expect(goals.getByTestId("goals-build-in-setup")).toHaveCount(0);

  // The run: the agents finish, it stops at Confirm the baseline, and the owner approves it.
  await openBuild.click();
  await expect(page).toHaveURL(new RegExp(`${runHref}$`));
  await expect(page.getByRole("heading", { name: "Build the baseline" }).first()).toBeVisible();
  const confirm = page.getByTestId("checkpoint-baseline_confirm");
  await expect(async () => {
    if (!(await confirm.filter({ hasText: "Waiting" }).isVisible())) await page.getByRole("button", { name: "Refresh progress" }).click();
    await expect(confirm.filter({ hasText: "Waiting" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  // A new company's sources gave the mock's agents no goal, so nothing blocks the approval.
  await confirm.getByRole("button", { name: "Approve and continue" }).click();
  await expect(confirm).toContainText("Approved");
  await expect(page.getByTestId("run-status").filter({ visible: true })).toHaveText("Succeeded");

  // Home: every step is done, so the checklist is not drawn, nor a Set up chip.
  await page.getByTestId("nav-home").filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId("home-needs")).toBeVisible();
  await expect(goals).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("home-setup-chip")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Set up/ })).toHaveCount(0);
  // The build is over: the Goals card no longer opens it nor points at Set up.
  await expect(goals.getByTestId("goals-open-build")).toHaveCount(0);
  await expect(goals.getByTestId("goals-build-in-setup")).toHaveCount(0);
});
