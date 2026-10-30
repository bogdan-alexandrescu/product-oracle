import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, pickZone, signOut } from "./helpers";

/*
 * qa-onboarding-6, qa-onboarding-41 and qa-onboarding-34 (desktop, mock-backed, through the UI
 * only): a new company's invited commenter or viewer lands in Simple on their first sign-in
 * and is welcomed there as Detailed welcomes them (their role's words and first steps, the
 * same dismissal), never with the owner's setup words; and a setup step opened from Simple's
 * Home returns to Simple's Home by its "Back to Home".
 * no_claim: the API's /v1/setup and its welcome (api/tests/test_setup.py; the mock stands in),
 * Google sign-in (the mock's sign-in form takes an open invite, as the API's IAP sign-in does),
 * and the wording (the owner's call, questions.json).
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** A new company (the "empty" scenario), with the mock's store reset once at the start (later loads keep what the test did). */
async function newCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-simple-welcome")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-simple-welcome", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

/** The owner invites `email` as `role` on Settings › Members, then signs out. */
async function invite(page: Page, email: string, role: string) {
  await login(page);
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Role", { exact: true }).selectOption(role);
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText(`Invite sent to ${email}`);
  await signOut(page);
}

/** Signs in from the bare sign-in page (no `next`): Oracle picks where to land. */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

// Detailed Home may stay mounted behind Simple (ModeRoot): read Simple's page only.
const simple = (page: Page) => page.getByTestId("simple-page");
const welcome = (page: Page) => simple(page).getByTestId("home-welcome");
const setupCard = (page: Page) => simple(page).getByTestId("home-setup");
const modeSwitch = (page: Page) => page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true });

test("qa-onboarding-6: an invited commenter lands in Simple and is welcomed as a commenter, not with the owner's setup", async ({ page }) => {
  // fails_when: the commenter lands in Simple with no welcome, the wrong role's words or steps,
  // a step not opening Simple's page, or the owner's "set up Oracle ... build the baseline" card
  await newCompany(page);
  await invite(page, "pat.example@example.com", "commenter");
  await signIn(page, "pat.example@example.com");
  await expect(page).toHaveURL(/\/simple$/);

  await expect(welcome(page).getByRole("heading", { name: "Welcome to Oracle" })).toBeVisible();
  await expect(welcome(page).getByTestId("welcome-role")).toContainText("You are a commenter");
  const steps = welcome(page).getByTestId("welcome-step");
  await expect(steps).toHaveText([/Connect your tools/, /Pick your sources/, /Read a PRD and comment/]);
  await expect(steps.nth(2).getByRole("link")).toHaveAttribute("href", "/simple/one-pagers");
  await expect(simple(page).getByRole("heading", { name: "Welcome: set up Oracle" })).toHaveCount(0);
  await expect(simple(page)).not.toContainText("build the baseline it plans from");

  // A step opens where it is done and its "Back to Home" returns to Simple's Home.
  await steps.nth(0).getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/connections\?from=simple-setup$/);
  await page.getByTestId("nav-back-home").click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(welcome(page).getByTestId("welcome-role")).toContainText("You are a commenter");
});

test("qa-onboarding-6: an invited viewer lands in Simple, is welcomed as a viewer, and dismissing it there dismisses it in Detailed", async ({ page }) => {
  // fails_when: the viewer gets no welcome in Simple, the wrong steps or links, the card goes before
  // its dismissal is saved, or the welcome dismissed in Simple comes back after a reload or in Detailed
  await newCompany(page);
  await invite(page, "sam.example@example.com", "viewer");
  await signIn(page, "sam.example@example.com");
  await expect(page).toHaveURL(/\/simple$/);

  await expect(welcome(page).getByTestId("welcome-role")).toContainText("You are a viewer");
  const steps = welcome(page).getByTestId("welcome-step");
  await expect(steps).toHaveText([/Read the goals/, /Open a PRD/, /Open the plan/]);
  await expect(steps.nth(1).getByRole("link")).toHaveAttribute("href", "/simple/one-pagers");
  await expect(steps.nth(2).getByRole("link")).toHaveAttribute("href", "/simple/roadmap");
  await expect(simple(page)).not.toContainText("build the baseline it plans from");

  // fix4 review: the card stays, its button busy, until the dismissal is saved, so a reload
  // right after it is gone cannot bring it back (the save answers late here).
  await page.evaluate(() => {
    localStorage.setItem("po-mock-slow", "PATCH /v1/me/preferences");
    localStorage.setItem("po-mock-slow-ms", "1500");
  });
  await welcome(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(welcome(page).getByRole("button", { name: "Dismissing…" })).toBeDisabled();
  await expect(welcome(page)).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("po-mock-slow"));
  await page.reload();
  await expect(simple(page).getByTestId("home-sentence")).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  await modeSwitch(page).getByRole("radio", { name: "Detailed" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
  await expect(page.getByTestId("home-welcome").filter({ visible: true })).toHaveCount(0);
});

test("qa-onboarding-34: a setup step opened from Simple's Home returns to Simple's Home by Back to Home, the step done", async ({ page }) => {
  // fails_when: "Back to Home" drops a Simple owner into Detailed (/home), or the step stays open
  await newCompany(page);
  await login(page, ADMIN.email);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("radiogroup", { name: "Mode" }).getByRole("radio", { name: "Simple" }).click();
  await expect(page).toHaveURL(/\/simple$/);
  const zoneStep = setupCard(page).getByTestId("home-setup-step").filter({ hasText: "Time zone" });
  await expect(zoneStep).not.toContainText("Done");

  await setupCard(page).getByRole("link", { name: "Time zone", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/company\?from=simple-setup#timezone$/);
  // Settings' own lane wins: the zone is one searchable picker (qa-settings-12), not a select.
  await pickZone(page, "America/Los_Angeles");
  await page.getByTestId("timezone-panel").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("timezone-panel").getByRole("status")).toHaveText("Saved");

  await page.getByTestId("nav-back-home").click();
  await expect(page).toHaveURL(/\/simple$/);
  await expect(zoneStep.getByRole("img", { name: "Done" })).toBeVisible();
  await expect(zoneStep.getByRole("link")).toHaveCount(0);
});
