import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

// A1 welcome (#140): a member who joined through an invite sees, on Home from their first
// sign-in, what Oracle is for them in their role and the first three things to do, until
// they dismiss it. Not an email: it is drawn in the app only.
//
// no_claim for every test here: the in-browser mock's /v1/setup stands in for the API's
// (api/tests/test_setup.py covers who is welcomed and the dismiss preference); in the mock
// a first sign-in with an open invite's email takes the invite, as the API's sign-in does.

const welcome = (page: Page) => page.getByTestId("home-welcome").filter({ visible: true });

/** An owner invites `email` as `role` on Settings › Members, then signs out. */
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

// Card welcome-commenter: protects = an invited commenter's first Home says what Oracle is
// for a commenter and lists three first steps that open the right pages; fails_when = no
// welcome, the wrong role's words, or a step link going elsewhere; no_claim = the wording is
// final (the owner's call, questions.json).
test("an invited commenter is welcomed on their first sign-in", async ({ page }) => {
  await invite(page, "pat.example@example.com", "commenter");
  await login(page, "pat.example@example.com");
  const w = welcome(page);
  await expect(w.getByRole("heading", { name: "Welcome to Oracle" })).toBeVisible();
  await expect(w.getByTestId("welcome-role")).toContainText("You are a commenter");
  const steps = w.getByTestId("welcome-step");
  await expect(steps).toHaveCount(3);
  await expect(steps).toHaveText([/Connect your tools/, /Pick your sources/, /Read a PRD and comment/]);
  await steps.nth(0).getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

// Card welcome-dismiss: protects = Dismiss keeps the welcome away for good, across sign-ins;
// fails_when = it comes back on the next visit or the next sign-in; no_claim = other people.
test("dismissing the welcome keeps it away", async ({ page }) => {
  await invite(page, "sam.example@example.com", "viewer");
  await login(page, "sam.example@example.com");
  await expect(welcome(page).getByTestId("welcome-role")).toContainText("You are a viewer");
  await expect(welcome(page).getByTestId("welcome-step")).toHaveText([/Read the goals/, /Open a PRD/, /Open the plan/]);
  await welcome(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(welcome(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  await signOut(page);
  await login(page, "sam.example@example.com");
  await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

// Card welcome-not-for-everyone: protects = the company's own members, who joined without an
// invite, see no welcome; fails_when = the owner or a seeded member is welcomed; no_claim =
// members who joined long ago (the API's 14-day rule, pytest).
test("members who were not invited see no welcome", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  await signOut(page);
  await login(page, "commenter@example.com");
  await expect(page.getByRole("heading", { name: "Home" }).first()).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
});

// Card welcome-approver-phone: protects = an approver's welcome names what approvers do and
// fits a phone; fails_when = the page scrolls sideways; no_claim = the layout's details.
test("an invited approver's welcome fits a phone", async ({ page }) => {
  await invite(page, "lee.example@example.com", "approver");
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "lee.example@example.com");
  await expect(welcome(page).getByTestId("welcome-role")).toContainText("You are an approver");
  await expect(welcome(page).getByTestId("welcome-step")).toHaveText([/Connect your tools/, /Pick your sources/, /See what waits for you/]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
