import { LADDER_SCENARIO } from "../lib/api/mock/goal-ladder";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * milestone-rename (the owner, Nov 10: "make all milestones editable in place"): a goal's measured
 * milestone is renamed in place with its code fixed before the name: M2 of the Goal map on the
 * Roadmap (its card) and on the Goal map (its ladder card), and a goal's own milestone (M5 here,
 * dated by the goal) on the Roadmap. Who decides the roadmap saves it, with Undo;
 * an approver who does not proposes it, the milestone reads "Proposed · waits for <name>", and
 * the owner accepts it in the Inbox; a viewer gets no field. Mock scenarios "simple-milestones"
 * (the Roadmap) and "goal-ladder" (the Goal map); invented goals, milestones and people.
 *
 * Card rename-goal-target: protects = a goal's own milestone (M5) and a Goal map one (M2) on the
 * Roadmap open "Edit M5" / "Edit M2" with a Name field; Save renames it there, the code stays; fails_when = its card reads only.
 * Card rename-ladder: protects = a Goal map milestone's name is a field in place; fails_when = the
 * ladder card has no way to rename it.
 * Card rename-propose: protects = an approver who does not decide the roadmap proposes the name,
 * it shows as waiting, and the owner's Accept in the Inbox renames it; fails_when = the field is
 * missing for them, or the proposal does not reach the owner's Inbox.
 * Card rename-viewer: protects = a viewer sees no name field; fails_when = a viewer gets one.
 */

const APPROVER = "approver@example.com";
const VIEWER = "viewer@example.com";

test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, scenario: string, path: string, email?: string) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto(path);
}

const label = (page: Page, code: string) => page.getByTestId("ms-label").filter({ hasText: new RegExp(`^${code} `) });
// "simple-milestones": the goal Faster activation's own milestone (its date, its measure) is M5.
const m2 = (page: Page) => label(page, "M5");
const card = (page: Page) => page.getByTestId("ms-card");
const ladderM2 = (page: Page) => page.getByTestId("ld-milestone").filter({ has: page.locator(".simple-code", { hasText: /^M2$/ }) });

async function roadmap(page: Page, code = "M5") {
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(label(page, code)).toBeVisible();
}

test("the roadmap's owner renames M2, a Goal map milestone, on the Roadmap", async ({ page }) => {
  await open(page, LADDER_SCENARIO, "/simple/roadmap");
  await roadmap(page, "M2");
  await label(page, "M2").click();
  await expect(card(page).getByRole("heading", { name: "Edit M2" })).toBeVisible();
  await card(page).getByLabel("Name", { exact: true }).fill("Setup in a day");
  await card(page).getByTestId("ms-save").click();
  await expect(page.getByTestId("ms-toast")).toContainText("M2 Setup in a day saved");
  await expect(label(page, "M2")).toContainText("M2 Setup in a day");
});

test("the roadmap's owner renames a goal's own milestone on the Roadmap; the goal keeps its name; Undo puts it back", async ({ page }) => {
  await open(page, "simple-milestones", "/simple/roadmap");
  await roadmap(page);
  const was = ((await m2(page).textContent()) ?? "").trim();
  await m2(page).click();
  await expect(card(page).getByRole("heading", { name: "Edit M5" })).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-rights", "change");
  const name = card(page).getByLabel("Name", { exact: true });
  await expect(name).toBeEnabled();
  await name.fill("Ninety teams activated");
  await card(page).getByTestId("ms-save").click();
  await expect(page.getByTestId("ms-toast")).toContainText("M5 Ninety teams activated saved");
  await expect(m2(page)).toContainText("M5 Ninety teams activated");
  await page.getByTestId("ms-toast").getByRole("button", { name: "Undo" }).click();
  await expect(m2(page)).not.toContainText("Ninety teams activated");
  expect(was).not.toContain("Ninety teams activated");
});

test("the roadmap's owner renames M2 in place on the Goal map", async ({ page }) => {
  await open(page, LADDER_SCENARIO, "/simple/goals");
  await expect(page.getByTestId("ld-goal").first()).toBeVisible();
  await ladderM2(page).getByTestId("ld-ms-name").click();
  const field = ladderM2(page).getByTestId("ld-ms-naming");
  await expect(field.locator(".simple-code")).toHaveText("M2");
  await field.getByLabel("Name").fill("Setup in a day");
  await field.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "M2 Setup in a day saved" })).toBeVisible();
  await expect(ladderM2(page).getByTestId("ld-ms-name")).toHaveText("M2Setup in a day");
});

test("an approver proposes a new name for a goal's own milestone; it waits for the owner, who accepts it in the Inbox", async ({ page }) => {
  await open(page, "simple-milestones", "/simple/roadmap", APPROVER);
  await roadmap(page);
  await m2(page).click();
  await expect(card(page)).toHaveAttribute("data-rights", "propose");
  await expect(card(page).getByTestId("ms-save")).toHaveCount(0);
  await card(page).getByLabel("Name", { exact: true }).fill("Ninety teams activated");
  await card(page).getByTestId("ms-propose").click();
  await expect(page.getByTestId("ms-toast")).toContainText("Proposed a change to M5");
  await expect(m2(page)).not.toContainText("Ninety teams activated");
  await m2(page).click();
  await expect(card(page).getByTestId("ms-proposed-state")).toHaveText("Proposed: Ninety teams activated · waits for Avery Stone");

  // The owner signs in and accepts it in the Inbox.
  await card(page).getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page);
  await page.goto("/inbox");
  const row = page.getByRole("row").filter({ hasText: "Ninety teams activated" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row).toHaveCount(0);
  await page.goto("/simple/roadmap");
  await roadmap(page);
  await expect(m2(page)).toContainText("M5 Ninety teams activated");
  await m2(page).click();
  await expect(card(page).getByTestId("ms-proposed-state")).toHaveCount(0);
});

test("a viewer sees no name field on the Roadmap or the Goal map", async ({ page }) => {
  await open(page, "simple-milestones", "/simple/roadmap", VIEWER);
  await roadmap(page);
  await m2(page).click();
  await expect(card(page)).toHaveAttribute("data-rights", "read");
  await expect(card(page).getByLabel("Name", { exact: true })).toBeDisabled();
  for (const id of ["ms-save", "ms-propose"]) await expect(card(page).getByTestId(id)).toHaveCount(0);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-page")).toBeVisible();
  await expect(page.getByTestId("ld-ms-name")).toHaveCount(0);
  await expect(page.getByTestId("ld-milestone").getByLabel("Name")).toHaveCount(0);
});
