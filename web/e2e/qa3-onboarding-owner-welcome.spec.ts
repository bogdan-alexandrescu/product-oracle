import { expect, test, type Page } from "./test";

import { login, signOut } from "./helpers";

/**
 * qa-onboarding-40, -7: an owner invites a second Owner through Settings › Members; the new
 * owner's first Home welcomes them in an owner's words above Set up, with one list of first
 * steps: the welcome points at Set up rather than repeat its steps, and never offers a step
 * that is done (Invite your team, with the team already there).
 *
 * no_claim: the mock has no Google sign-in; its sign-in form takes the open invite as the
 * API's Google (IAP) sign-in does. The welcome's wording is the owner's call (questions.json).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const NEW_OWNER = "nia.example@example.com";
const welcome = (page: Page) => page.getByTestId("home-welcome").filter({ visible: true });
const panel = (page: Page) => page.getByTestId("home-setup");

test("an invited owner's first Home: welcome in an owner's words, pointing at Set up, no finished step offered", async ({ page }) => {
  // protects=qa-onboarding-40/-7; fails_when=no welcome for an invited owner, the welcome
  // lists Connect/Pick sources/Invite above the checklist with the same steps, or offers
  // Invite your team though the step is ticked; no_claim=other roles (welcome.spec.ts).
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "empty"));
  await login(page);

  // The owner invites a new Owner, as a person does, on Settings › Members.
  await page.goto("/settings/members");
  const form = page.getByRole("form", { name: "Invite" });
  await form.getByLabel("Email").fill(NEW_OWNER);
  await form.getByLabel("Role", { exact: true }).selectOption("owner");
  await form.getByRole("button", { name: "Send invite", exact: true }).click();
  await expect(page.getByTestId("invite-outcome")).toHaveText(`Invite sent to ${NEW_OWNER}`);
  await signOut(page);

  // The new owner's first sign-in lands on Home.
  await login(page, NEW_OWNER);
  const w = welcome(page);
  await expect(w.getByRole("heading", { name: "Welcome to Oracle" })).toBeVisible();
  await expect(w.getByTestId("welcome-role")).toHaveText("You are an owner: you set Oracle up for the company and decide who joins.");

  // Set up is drawn below the welcome; the welcome points there instead of a second list.
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("panel-count")).toHaveText("2 of 8");
  await expect(w.getByTestId("welcome-setup")).toHaveText("Begin with Set up, below. Each step opens the page where you do it.");
  await expect(w.getByTestId("welcome-step")).toHaveCount(0);
  await expect(w).not.toContainText("Invite your team");
  const [welcomeBottom, setupTop] = await page.evaluate(() => [
    document.querySelector("[data-testid=home-welcome]")!.getBoundingClientRect().bottom,
    document.querySelector("[data-testid=home-setup]")!.getBoundingClientRect().top,
  ]);
  expect(setupTop).toBeGreaterThanOrEqual(welcomeBottom);
  // Invite team is ticked in Set up (the company's people are there).
  await expect(page.getByTestId("setup-row-invite")).toHaveAttribute("data-done", "true");

  // With Set up hidden, the welcome lists the steps still to do, and only those.
  await panel(page).getByRole("button", { name: "Hide" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set up 2 of 8" })).toBeVisible();
  await expect(w.getByTestId("welcome-setup")).toHaveCount(0);
  await expect(w.getByTestId("welcome-step")).toHaveText([/Connect your tools/, /Pick your sources/]);
  await expect(w).not.toContainText("Invite your team");

  // A step opens where it is done.
  await w.getByRole("link", { name: "Connect your tools" }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});
