import { GM_TRACKS_SCENARIO } from "../lib/api/mock/goal-map-tracks";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Goal map, "Goals by tracks grid": a feature that serves two goals has a chip under each, every one
 * naming that goal's milestones; Move to..., No milestone and Add a feature change only the links of
 * the chip's own goal, each with a toast that says what changed and an Undo that puts each link back.
 * Driven through the UI against the mock ("goal-map-tracks": invented goals, milestones and features).
 *
 * Test cards (protects / fails_when / no_claim) are each test's comment.
 */

test.use({ viewport: { width: 1512, height: 900 } });

const DEMOS = "Booked demos per rep per day";
const REVENUE = "Revenue per day";

async function open(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, GM_TRACKS_SCENARIO] as const);
  await login(page);
  await page.goto("/simple/goals");
  await expect(page.getByTestId("gm-grid")).toBeVisible();
}

/** The chips of a feature in one goal's column. */
async function chipIn(page: Page, goalName: string, name: string) {
  const id = await page.getByTestId("gm-goal").filter({ hasText: goalName }).getAttribute("data-goal");
  return page.locator(`[data-testid="gm-cell"][data-goal="${id}"]`).getByTestId("gm-chip").filter({ hasText: name });
}
const strip = (page: Page, name: string) => page.getByTestId("gm-strip-milestone").filter({ hasText: name });
const toast = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

async function moveTo(page: Page, goalName: string, name: string, to: string | RegExp) {
  const c = await chipIn(page, goalName, name);
  await c.hover();
  await c.getByRole("button", { name: new RegExp(`More for .*${name}`) }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("dialog", { name: new RegExp(`Move .*${name}`) }).getByRole("button", { name: to }).click();
}

async function addFeature(page: Page, milestone: string, name: string, save: "Add" | "Move here") {
  const m = strip(page, milestone);
  await m.hover();
  await m.getByRole("button", { name: new RegExp(`More for .*${milestone.replace(/\$/g, "\\$")}`) }).click();
  await page.getByRole("menuitem", { name: "Add a feature" }).click();
  const drawer = page.getByRole("dialog", { name: "Add a feature" });
  await drawer.getByPlaceholder("Search the roadmap").fill(name);
  await drawer.getByTestId("gm-attach-list").getByRole("button", { name: new RegExp(name) }).click();
  await drawer.getByRole("button", { name: save, exact: true }).click();
  await expect(drawer).toHaveCount(0);
}

test.describe("A feature that serves more than one goal", () => {
  test("Move to... another goal moves every link of the chip's goal; the toast names them; Undo puts each back", async ({ page }) => {
    // protects: a chip on two milestones of one goal, moved to another goal's milestone, leaves no
    // hidden link behind and its toast names both. fails_when: only the first link moves, so the
    // chip reads only the new milestone while the other link is shown nowhere (review A).
    await open(page);
    const name = "No-show reminder texts";
    await moveTo(page, DEMOS, name, /\$15k revenue per day/);
    await expect(await chipIn(page, REVENUE, name)).toContainText("$15k revenue per day");
    await expect(await chipIn(page, REVENUE, name)).not.toContainText("demos per rep");
    await expect(await chipIn(page, DEMOS, name)).toHaveCount(0);
    await expect(toast(page, /Moved .*No-show reminder texts from .*32 demos per rep and .*40 demos per rep to .*\$15k revenue per day/)).toBeVisible();
    await toast(page, /Moved .*No-show reminder texts from/).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, /Moved .*No-show reminder texts back to .*32 demos per rep and .*40 demos per rep/)).toBeVisible();
    await expect(await chipIn(page, REVENUE, name)).toHaveCount(0);
    const back = await chipIn(page, DEMOS, name);
    await expect(back).toContainText("32 demos per rep");
    await expect(back).toContainText("40 demos per rep");
    await back.getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.getByTestId("gm-panel-milestone")).toContainText("+1 demo a day");
    await expect(page.getByTestId("gm-panel-milestone")).toContainText("+3 demos a day");
  });

  test("after Move to... another goal, no link is left behind on the old goal", async ({ page }) => {
    // protects: the moved chip carries every link it had. fails_when: the second link stays on the
    // old goal unseen, and turns up there once the moved chip is taken off its milestone (review A).
    await open(page);
    const name = "No-show reminder texts";
    await moveTo(page, DEMOS, name, /\$15k revenue per day/);
    await expect(await chipIn(page, REVENUE, name)).toBeVisible();
    await moveTo(page, REVENUE, name, "No milestone");
    await expect(await chipIn(page, REVENUE, name)).toHaveCount(0);
    await expect(await chipIn(page, DEMOS, name)).toContainText("No milestone");
    await expect(await chipIn(page, DEMOS, name)).not.toContainText("40 demos per rep");
    // fails_when: the toast says only "to No milestone" while the chip lands under another goal (round 3, 1).
    await expect(toast(page, new RegExp(`Moved .*${name} to No milestone \\(${DEMOS}\\)`))).toBeVisible();
    await expect(await chipIn(page, DEMOS, name)).toHaveAttribute("data-moved", "1");
  });

  test("Add a feature from another goal makes a chip in this goal too, with a toast and Undo", async ({ page }) => {
    // protects: a link added on another goal is shown there, and says so. fails_when: no toast and
    // no chip under the goal it was added to (review B).
    await open(page);
    const name = "Lead list ranking";
    await addFeature(page, "$15k revenue per day", name, "Add");
    await expect(await chipIn(page, REVENUE, name)).toContainText("$15k revenue per day");
    await expect(await chipIn(page, DEMOS, name)).toContainText("32 demos per rep");
    // Only the chip it was added to rings, not its chip under the other goal (round 3, 2).
    await expect(await chipIn(page, REVENUE, name)).toHaveAttribute("data-moved", "1");
    await expect(await chipIn(page, DEMOS, name)).not.toHaveAttribute("data-moved", /./);
    await expect(await chipIn(page, DEMOS, name)).not.toContainText("$15k");
    await toast(page, /Added .*Lead list ranking to .*\$15k revenue per day/).getByRole("button", { name: "Undo" }).click();
    await expect(await chipIn(page, REVENUE, name)).toHaveCount(0);
    await expect(await chipIn(page, DEMOS, name)).toContainText("32 demos per rep");
  });

  test("No milestone takes off only the chip's own goal's links and says so; Undo puts them back", async ({ page }) => {
    // protects: No milestone on one goal's chip leaves the other goal's link, and the toast tells
    // the truth. fails_when: the toast says No milestone while the chip jumps to the other goal (review C).
    await open(page);
    const name = "Lead list ranking";
    await addFeature(page, "$15k revenue per day", name, "Add");
    await expect(await chipIn(page, REVENUE, name)).toBeVisible();
    await moveTo(page, DEMOS, name, "No milestone");
    await expect(toast(page, /Took .*Lead list ranking off .*32 demos per rep; it stays on .*\$15k revenue per day/)).toBeVisible();
    await expect(await chipIn(page, DEMOS, name)).toHaveCount(0);
    await expect(await chipIn(page, REVENUE, name)).toContainText("$15k revenue per day");
    await toast(page, /Took .*Lead list ranking off/).getByRole("button", { name: "Undo" }).click();
    await expect(await chipIn(page, DEMOS, name)).toContainText("32 demos per rep");
    await expect(await chipIn(page, REVENUE, name)).toContainText("$15k revenue per day");
    await (await chipIn(page, DEMOS, name)).getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.getByTestId("gm-panel-milestone")).toContainText("+2 demos a day");
  });

  test("each of its chips opens the same feature panel, on that chip's goal", async ({ page }) => {
    // protects: every chip opens Simple's one feature panel. fails_when: the second chip opens nothing.
    await open(page);
    const name = "Lead list ranking";
    await addFeature(page, "$15k revenue per day", name, "Add");
    await (await chipIn(page, REVENUE, name)).getByRole("button", { name: new RegExp(name) }).click();
    await expect(page.getByTestId("floating-card").getByTestId("card-name")).toContainText(/F-\d+\s*Lead list ranking/);
    await expect(page.getByTestId("gm-panel-milestone")).toContainText("$15k revenue per day");
  });
});

test.describe("Add a feature's toasts", () => {
  test("Move here says what moved, and Undo puts it back", async ({ page }) => {
    // protects: Move here confirms itself with Undo, as Move to... does. fails_when: it is silent.
    await open(page);
    const name = "Rep calendar sync";
    await addFeature(page, "40 demos per rep", name, "Move here");
    await toast(page, /Moved .*Rep calendar sync from .*32 demos per rep to .*40 demos per rep/).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page, /Moved .*Rep calendar sync back to .*32 demos per rep/)).toBeVisible();
    await expect(await chipIn(page, DEMOS, name)).toContainText("32 demos per rep");
    await expect(await chipIn(page, DEMOS, name)).not.toContainText("40 demos per rep");
  });
});

test.describe("Badges as variant B draws them", () => {
  test("a goal's Not measured has no dotted underline; a strip's No gate is 12px", async ({ page }) => {
    // protects: the owner's picked mock-up's badges. fails_when: the badge is underlined or 11.5px.
    await open(page);
    const nm = page.getByTestId("gm-goal").filter({ hasText: "Activations per team per week" }).getByRole("button", { name: "Not measured" });
    expect(await nm.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
    const ng = strip(page, "Self-serve setup").getByRole("button", { name: "No gate" });
    expect(await ng.evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
  });
});

test.describe("On a phone, a feature that serves more than one goal", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("No milestone that lands the chip under its own goal scrolls to it there", async ({ page }) => {
    // protects: the chip is brought into sight where it lands. fails_when: it looks for the chip
    // under the goal it left, finds nothing, and the grid stays scrolled away (round 3, 1).
    await open(page);
    const name = "No-show reminder texts";
    await moveTo(page, DEMOS, name, /\$15k revenue per day/);
    await expect(await chipIn(page, REVENUE, name)).toBeVisible();
    await page.getByTestId("gm-grid").evaluate((el) => (el.scrollLeft = el.scrollWidth));
    await expect(await chipIn(page, DEMOS, name)).not.toBeInViewport({ ratio: 1 });
    await moveTo(page, REVENUE, name, "No milestone");
    await expect(await chipIn(page, DEMOS, name)).toBeInViewport({ ratio: 1 });
  });
});
