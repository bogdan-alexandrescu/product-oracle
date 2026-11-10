import { MOCK_FAIL_ONCE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * milestone-rights: a roadmap's own goal milestone's card follows the milestone's own rights.
 * Who changes the roadmap (its owner; the mock's company owner here) saves and removes it; an
 * approver who is not the roadmap's owner gets Propose and Propose removing it instead, sent as
 * an edit_goal_milestone proposal that the owner accepts in Needs a decision; a viewer reads
 * it with no controls. A refusal shows on the card in one line and keeps what was typed. Mock
 * scenario "simple-milestones" (invented goals, items and people), desktop 1440 and phone 390,
 * light and dark.
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const M1 = "M1 Alerts live for 50 teams";
// The built states, for a look: MR_SHOTS=<dir>.
const SHOTS = process.env.MR_SHOTS;
const shot = async (page: Page, name: string, size: string, scheme: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png` });
};

async function open(page: Page, scheme: "light" | "dark", email?: string) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem(themeKey, theme);
    },
    [MOCK_SCENARIO_KEY, "simple-milestones", THEME_KEY, scheme] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
  await roadmap(page);
}

/** Simple Roadmap; on a phone its Gantt, where the milestones' labels sit on the axis. */
async function roadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  if (phone(page)) await page.getByTestId("format-gantt").click();
}

const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 500;

/** Signs out from the rail's account menu, or a phone's. */
async function signOut(page: Page) {
  await page.getByTestId(phone(page) ? "phone-user-menu" : "user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

const label = (page: Page, words: string) => page.getByTestId("ms-label").filter({ hasText: words });
const card = (page: Page) => page.getByTestId("ms-card");
const toast = (page: Page) => page.getByTestId("ms-toast");

async function openM1(page: Page) {
  await label(page, M1).click();
  await expect(card(page)).toBeVisible();
}

for (const [size, device] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`milestone rights (${size}, ${scheme})`, () => {
      test.use(device);

      test("the roadmap's owner saves it", async ({ page }) => {
        await open(page, scheme);
        await openM1(page);
        await expect(card(page)).toHaveAttribute("data-rights", "change");
        await expect(card(page).getByTestId("ms-remove")).toBeVisible();
        await expect(card(page).getByTestId("ms-propose")).toHaveCount(0);
        await card(page).getByLabel("Name").fill("Alerts live for 55 teams");
        await card(page).getByTestId("ms-save").click();
        await expect(toast(page)).toContainText("M1 Alerts live for 55 teams saved");
        await expect(label(page, "M1 Alerts live for 55 teams")).toBeVisible();
      });

      test("an approver who is not its owner proposes; the owner accepts it", async ({ page }) => {
        await open(page, scheme, APPROVER);
        await openM1(page);
        await expect(card(page)).toHaveAttribute("data-rights", "propose");
        await expect(card(page).getByTestId("ms-save")).toHaveCount(0);
        await expect(card(page).getByTestId("ms-remove")).toHaveCount(0);
        await expect(card(page).getByTestId("ms-propose-remove")).toHaveText("Propose removing it");
        await shot(page, "propose-card", size, scheme);
        await card(page).getByLabel("Name").fill("Alerts live for 60 teams");
        // A refusal shows on the card in one line, and what was typed stays.
        await page.evaluate(([key]) => localStorage.setItem(key, "POST /v1/simple/changes"), [MOCK_FAIL_ONCE_KEY] as const);
        await card(page).getByTestId("ms-propose").click();
        await expect(card(page).getByTestId("ms-error")).toBeVisible();
        await expect(card(page).getByLabel("Name")).toHaveValue("Alerts live for 60 teams");
        await shot(page, "refused-card", size, scheme);
        await card(page).getByTestId("ms-propose").click();
        await expect(toast(page)).toContainText("Proposed a change to M1 Alerts live for 50 teams");
        await expect(card(page)).toHaveCount(0);
        await expect(label(page, M1)).toBeVisible();

        // The roadmap's owner signs in and decides it where the roadmap's proposals wait.
        await page.goto("/home");
        await signOut(page);
        await login(page);
        await roadmap(page);
        await page.getByTestId("needs-decision").click();
        const tray = page.getByTestId("decision-tray");
        const row = tray.getByTestId("tray-proposal").filter({ hasText: "Milestone 'M1 Alerts live for 50 teams': change it" });
        await expect(row).toBeVisible();
        await row.scrollIntoViewIfNeeded();
        await shot(page, "owner-tray", size, scheme);
        await row.getByRole("button", { name: "Accept" }).click();
        await expect(row).toHaveCount(0);
        await tray.getByRole("button", { name: "Close" }).click();
        await expect(label(page, "M1 Alerts live for 60 teams")).toBeVisible();
      });

      test("a viewer reads it with no controls", async ({ page }) => {
        await open(page, scheme, VIEWER);
        await openM1(page);
        await expect(card(page)).toHaveAttribute("data-rights", "read");
        for (const id of ["ms-save", "ms-remove", "ms-propose", "ms-propose-remove"]) await expect(card(page).getByTestId(id)).toHaveCount(0);
        await expect(card(page).getByLabel("Name")).toBeDisabled();
        await shot(page, "viewer-card", size, scheme);
        await card(page).getByRole("button", { name: "Close" }).click();
        await expect(card(page)).toHaveCount(0);
      });
    });
  }
}
