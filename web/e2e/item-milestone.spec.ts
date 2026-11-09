import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * item-milestone (product gap, Nov 6, 2026: no screen could put a roadmap item in a milestone):
 * the one feature panel's Milestone row is a picker for every roadmap item, offering each
 * milestone of the company roadmap across its PRDs (code and name, the PRD beside it when there
 * are several), or none. A pick goes into the working draft with Undo (a commenter's is a
 * proposal), and the Gantt's Group by Milestone regroups at once. Driven through the UI against
 * the mock's "item-milestone" scenario: the "one-roadmap" company roadmap (User Safety and Scale
 * items) with both PRDs' milestones. Invented data only.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const SAFETY_M1 = "M1 Reports reach a person (User Safety)";
const SAFETY_M2 = "M2 Blocks hold everywhere (User Safety)";
const SAFETY_M3 = "M3 Ready for launch (User Safety)";
const SCALE_M1 = "M1 Load measured (Scale)";
const SCALE_M2 = "M2 Twice the load (Scale)";
// The same code and name as User Safety's M3: told apart by id, never by name.
const SCALE_M3 = "M3 Ready for launch (Scale)";
const ITEM = "read-replicas";

async function open(page: Page, email: string = ADMIN.email) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, "item-milestone"] as const);
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

const card = (page: Page): Locator => page.getByTestId("floating-card");

/** Opens the Milestone picker in the open card and saves `label`. */
async function pick(page: Page, label: string) {
  await card(page).getByRole("button", { name: "Change the milestone" }).click();
  await card(page).getByLabel("Milestone", { exact: true }).selectOption({ label });
  await card(page).getByRole("button", { name: "Save" }).click();
}

/** The items (their keys) in a lane of the Gantt: the bars between its header and the next one's. */
async function itemsIn(page: Page, title: string): Promise<string[]> {
  const header = page.getByTestId("chart-group").filter({ has: page.locator("span", { hasText: new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`) }) });
  await expect(header, `a lane "${title}"`).toHaveCount(1);
  await header.scrollIntoViewIfNeeded();
  const top = (await header.boundingBox())!.y;
  const tops = await page.locator('[data-testid="chart-group"], [data-testid="below-the-line"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  const next = Math.min(...tops.filter((t) => t > top + 1), Number.POSITIVE_INFINITY);
  return page.locator('g[data-testid="bar"]').evaluateAll(
    (els, [from, to]) =>
      els
        .filter((e) => {
          const r = e.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          return mid > from && mid < to;
        })
        .map((e) => e.getAttribute("data-item") ?? ""),
    [top, next] as const,
  );
}

const lane = (page: Page, title: string): Locator => page.getByTestId("chart-group").filter({ has: page.locator("span", { hasText: title }) });

for (const [name, device] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(`a feature's milestone in its panel (${name})`, () => {
    test.use(device);
    test.setTimeout(90_000);

    /**
     * protects = Read replicas (a Scale item with no milestone) gets a Milestone picker in its
     * panel offering No milestone and every milestone of the company roadmap, User Safety's and
     * Scale's, each by code and name with its PRD; picking User Safety's M2 says so with Undo and
     * the panel reads it; the Gantt's Group by Milestone puts it in that lane; a second pick made
     * from the grouped Gantt moves it to Scale's M1 lane at once; Undo moves it back; No
     * milestone puts it with the rest; fails_when = the row is read-only or missing, a PRD's
     * milestones are not offered, the pick is not saved, or the Gantt keeps the old grouping
     * until a reload; no_claim = how the API stores the pick (api pytest).
     */
    test("an owner puts a feature in any PRD's milestone and the Gantt regroups", async ({ page }) => {
      await open(page);
      await openRoadmapItem(page, ITEM);
      await expect(card(page)).toBeVisible();
      await expect(card(page).getByTestId("card-milestone")).toHaveText("No milestone");
      await card(page).getByRole("button", { name: "Change the milestone" }).click();
      await expect(card(page).getByLabel("Milestone", { exact: true }).locator("option")).toHaveText(["No milestone", SCALE_M1, SCALE_M2, SCALE_M3, SAFETY_M1, SAFETY_M2, SAFETY_M3]);
      await card(page).getByRole("button", { name: "Cancel" }).click();

      await pick(page, SAFETY_M2);
      await expect(page.getByText("Milestone changed in your working draft").first()).toBeVisible();
      await expect(card(page).getByTestId("card-milestone")).toHaveText(SAFETY_M2);
      await card(page).getByRole("button", { name: "Close" }).click();

      await page.getByTestId("format-gantt").click();
      await page.getByTestId("group-milestone").click();
      expect(await itemsIn(page, SAFETY_M2)).toEqual([ITEM]);
      expect(await itemsIn(page, "No milestone")).not.toContain(ITEM);

      // From the grouped Gantt: its bar opens the same panel; the lane follows the pick at once.
      const bar = page.locator(`g[data-testid="bar"][data-item="${ITEM}"]`);
      await bar.scrollIntoViewIfNeeded();
      await bar.click();
      await expect(card(page).getByTestId("card-milestone")).toHaveText(SAFETY_M2);
      await pick(page, SCALE_M1);
      await expect(card(page).getByTestId("card-milestone")).toHaveText(SCALE_M1);
      await expect(lane(page, SAFETY_M2)).toHaveCount(0);
      expect(await itemsIn(page, SCALE_M1)).toEqual([ITEM]);

      // Undo puts it back in User Safety's M2.
      await page.getByRole("button", { name: "Undo" }).last().click();
      await expect(card(page).getByTestId("card-milestone")).toHaveText(SAFETY_M2);
      await expect(lane(page, SCALE_M1)).toHaveCount(0);
      expect(await itemsIn(page, SAFETY_M2)).toEqual([ITEM]);

      await pick(page, "No milestone");
      await expect(card(page).getByTestId("card-milestone")).toHaveText("No milestone");
      await expect(lane(page, SAFETY_M2)).toHaveCount(0);
      expect(await itemsIn(page, "No milestone")).toContain(ITEM);
    });

    /**
     * protects = a pick is checked against the milestone the feature is in by its id: another tab
     * moves it from User Safety's M3 Ready for launch to Scale's, which reads the same name, and
     * a pick from the panel still showing User Safety's is refused as changed since;
     * fails_when = the two are told apart by name only, so the stale pick goes through;
     * no_claim = the API's check (api pytest).
     */
    test("a stale pick is refused when the feature moved to a milestone of the same name", async ({ page }) => {
      await open(page);
      await openRoadmapItem(page, ITEM);
      await pick(page, SAFETY_M3);
      await expect(card(page).getByTestId("card-milestone")).toHaveText(SAFETY_M3);
      // Someone else (the same person in another tab) moves it to Scale's milestone of that name.
      const other = await page.context().newPage();
      await other.goto("/simple/roadmap");
      await expect(other.getByTestId("simple-roadmap")).toBeVisible();
      await openRoadmapItem(other, ITEM);
      await expect(card(other).getByTestId("card-milestone")).toHaveText(SAFETY_M3);
      await pick(other, SCALE_M3);
      await expect(card(other).getByTestId("card-milestone")).toHaveText(SCALE_M3);
      await other.close();
      await pick(page, SAFETY_M1);
      await expect(page.getByText(/Changed since you saw it/).first()).toBeVisible();
      await expect(card(page).getByTestId("card-milestone")).not.toHaveText(SAFETY_M1);
    });

    /**
     * protects = a commenter's pick is a proposal for the people who decide: the panel says it
     * waits in Needs a decision and the feature stays in no milestone; fails_when = the
     * commenter's pick applies, or the picker is missing for them; no_claim = deciding it (the
     * change engine's own specs).
     */
    test("a commenter's pick waits for a decision", async ({ page }) => {
      await open(page, "commenter@example.com");
      await openRoadmapItem(page, ITEM);
      await expect(card(page).getByTestId("card-milestone")).toHaveText("No milestone");
      await pick(page, SCALE_M1);
      await expect(page.getByText(/^Milestone changed proposed: it waits for/).first()).toBeVisible();
      await expect(card(page).getByTestId("card-milestone")).toHaveText("No milestone");
    });
  });
}

/**
 * protects = each of the company roadmap's PRD milestones (User Safety's and Scale's), opened on
 * the roadmap, names the PRD's owner (its track's owner, Lena Moss); fails_when = a card reads
 * "the PRD's owner" (no track owner found, or every item read as one PRD's); no_claim = who
 * decides an ask (milestone-asks.spec.ts).
 */
test("each PRD milestone on the company roadmap names its owner", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(DESKTOP.viewport);
  await open(page);
  const label = (name: string) => page.getByTestId("ms-prd-label").filter({ hasText: new RegExp(`^PRD · ${name}$`) });
  for (const [name, nth, prdTitle] of [
    ["M1 Reports reach a person", 0, "User Safety"],
    ["M2 Blocks hold everywhere", 0, "User Safety"],
    ["M1 Load measured", 0, "Scale"],
    ["M2 Twice the load", 0, "Scale"],
    // Both M3s (one day, one name) share one label.
    ["M3 Ready for launch", 0, null],
  ] as const) {
    await label(name).nth(nth).click();
    const prd = page.getByTestId("ms-prd-card");
    await expect(prd).toContainText(prdTitle ? `From the PRD ${prdTitle} · owned by Lena Moss` : /From the PRD (User Safety|Scale) · owned by Lena Moss/);
    await expect(prd).toContainText("A change here goes to Lena Moss as a change to the PRD");
    await prd.getByRole("button", { name: "Cancel" }).click();
    await expect(prd).toHaveCount(0);
  }
});
