import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * qa-onboarding-44 and qa-onboarding-25 (desktop, mock 'empty' scenario, through the UI only):
 * a commenter, an approver and a viewer of a new company follow the Set up links: their own
 * steps from Home's checklist, and the owner's steps' links (Members, Company, Baseline) as a
 * shared link opens them. What their role may not do there is hidden or refused with a reason.
 * no_claim: the API's refusals (api/tests: role checks on every route); the owner's walk
 * (qa2-onboarding-checklist, fix4-setup-onboarding).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const ROLES = [
  { role: "commenter", email: "commenter@example.com", steps: ["connect", "sources"], invites: false, builds: false },
  { role: "approver", email: "approver@example.com", steps: ["connect", "sources"], invites: true, builds: true },
  { role: "viewer", email: "viewer@example.com", steps: [], invites: false, builds: false },
] as const;

/** The owner's Set up links, as Home's checklist has them (app/home/_setup.tsx). */
const OWNER_LINKS = {
  members: "/settings/members?from=setup#engineering-lead",
  horizons: "/settings/company?from=setup#horizons",
  timezone: "/settings/company?from=setup#timezone",
  build: "/baseline?build=1",
};

/** The empty scenario, with the mock's company store reset once at the start. */
async function emptyCompany(page: Page) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem("fix4-setup-roles")) {
        localStorage.removeItem("po-mock-db-v2");
        sessionStorage.setItem("fix4-setup-roles", "1");
      }
      localStorage.setItem(key, value);
    },
    [MOCK_SCENARIO_KEY, "empty"] as const,
  );
}

for (const r of ROLES) {
  // protects: qa-onboarding-44, -25: a role's own Set up steps open with the way back; the
  // owner's steps say who does them: Members says the role, Company that only owners set the
  // horizons and the time zone, Baseline's ?build=1 who builds the baseline (or opens the
  // build for an approver).
  // fails_when: a form the role cannot use is offered, a refusal gives no reason, or ?build=1
  // is silently ignored.
  test(`qa-onboarding-44: a ${r.role} follows the setup links`, async ({ page }) => {
    await emptyCompany(page);
    await login(page, r.email);

    // Home's checklist: only the role's own steps.
    const setup = page.getByTestId("home-setup");
    if (r.steps.length === 0) {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(setup).toHaveCount(0);
    } else {
      await expect(setup.locator('[data-testid^="setup-row-"]')).toHaveCount(r.steps.length);
      for (const key of r.steps) await expect(page.getByTestId(`setup-row-${key}`)).toBeVisible();
      await expect(page.getByTestId("setup-row-timezone")).toHaveCount(0);
      await page.getByTestId("setup-row-connect").getByTestId("setup-action").click();
      await expect(page).toHaveURL(/\/settings\/connections\?from=setup$/);
      const back = page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Back to Home" });
      await expect(back).toBeVisible();
      await back.click();
      await expect(page).toHaveURL(/\/home$/);
    }

    // Members: the role in words; naming the engineering lead stays with owners.
    await page.goto(OWNER_LINKS.members);
    const note = page.getByTestId("role-note");
    await expect(note).toContainText(new RegExp(`Your role is ${r.role}\\.`, "i"));
    await expect(note).toContainText(r.invites ? "You can invite viewers and commenters" : "Owners manage members and sign-in.");
    await expect(page.getByRole("checkbox", { name: /^Engineering lead: / })).toHaveCount(0);

    // Company: View only, and why the horizons and the time zone are not there.
    for (const link of [OWNER_LINKS.horizons, OWNER_LINKS.timezone]) {
      await page.goto(link);
      await expect(page.getByTestId("company-owner-only")).toHaveText("Only owners set horizons and the time zone.");
      await expect(page.getByTestId("view-only")).toBeVisible();
      await expect(page.getByTestId("timezone-panel")).toHaveCount(0);
      await expect(page.locator("#horizons")).toHaveCount(0);
      await expect(page.getByTestId("branding-panel")).toBeVisible();
      await expect(page.getByTestId("branding-panel").getByRole("button", { name: "Save branding" })).toHaveCount(0);
    }

    // Baseline's ?build=1: the build for an approver; for the others, who builds it.
    await page.goto(OWNER_LINKS.build);
    await expect(page.getByRole("heading", { level: 1, name: "Baseline" })).toBeVisible();
    const sheet = page.getByRole("dialog", { name: "Build the baseline" });
    if (r.builds) {
      await expect(sheet).toBeVisible();
      await expect(page.getByTestId("build-refused")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("build-refused")).toHaveText("Approvers and owners build the baseline.");
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Build baseline" })).toHaveCount(0);
    }
  });
}
