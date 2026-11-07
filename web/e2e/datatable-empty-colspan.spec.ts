import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * A DataTable's empty line spans only the columns a person can see: a table narrower than
 * 760 px drops its narrow columns, and the empty line stays inside the table, as wide as
 * its header row (it used to span the hidden columns too, which took the visible ones' room).
 */

async function openEmptyPlan(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("po-mock-scenario", "empty");
    if (!sessionStorage.getItem("colspan-reset")) {
      localStorage.removeItem("po-mock-db-v2");
      sessionStorage.setItem("colspan-reset", "1");
    }
  });
  await login(page);
  await page.goto("/plan/documents");
}

async function expectInside(table: Locator) {
  const empty = table.getByTestId("table-empty");
  await expect(empty).toBeVisible();
  const headers = table.locator("th").filter({ visible: true });
  // Measured once the table has settled (a column can come in once the person's rights load).
  await expect(async () => {
    const n = await headers.count();
    const box = (await table.boundingBox())!;
    const cell = (await empty.boundingBox())!;
    expect(cell.x + cell.width).toBeLessThanOrEqual(box.x + box.width + 1);
    // The columns a person sees share the table's whole width: none is left to a hidden one.
    let width = 0;
    for (const h of await headers.all()) width += (await h.boundingBox())!.width;
    expect(Math.abs(width - box.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(cell.width - width)).toBeLessThanOrEqual(1);
    expect(await empty.getAttribute("colspan")).toBe(String(n));
  }).toPass({ timeout: 5000 });
}

test.describe("a narrow window", () => {
  test.use({ viewport: { width: 880, height: 900 } });

  test("an empty table that hides columns keeps its empty line inside the table", async ({ page }) => {
    await openEmptyPlan(page);
    const roadmaps = page.getByTestId("roadmaps-table");
    await expect(roadmaps.getByTestId("table-empty")).toHaveText("No roadmaps yet. Build one from an approved PRD.");
    // The table is under 760 px wide here, so it drops its Template column: the case that spilled.
    await expect(roadmaps.getByRole("columnheader", { name: "Roadmap" })).toBeVisible();
    await expect(roadmaps.getByRole("columnheader", { name: "Template" })).toBeHidden();
    await expectInside(roadmaps);
  });
});

/*
 * The first frame: the server's HTML, painted before the page's scripts run, shows the table's
 * loading lines. They span the columns drawn at that width (they used to span every column, so
 * a hidden one took the visible ones' room until the table had measured itself).
 */
for (const width of [880, 1024, 1440]) {
  test.describe(`the first frame at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the Runs table's lines span only the columns drawn before its scripts run", async ({ page }) => {
      await login(page);
      // The page as first painted: its HTML and CSS, none of its scripts.
      await page.route(/\/_next\/static\/chunks\/.*\.js(\?|$)/, (route) => route.abort());
      await page.goto("/runs");
      const table = page.getByTestId("runs-table").locator("table");
      const line = table.locator("td").filter({ visible: true }).first();
      await expect(line).toBeAttached();
      const headers = table.locator("th").filter({ visible: true });
      const box = (await table.boundingBox())!;
      let sum = 0;
      for (const h of await headers.all()) sum += (await h.boundingBox())!.width;
      expect(Math.abs(sum - box.width), "the columns drawn share the table's whole width").toBeLessThanOrEqual(1);
      expect(Math.abs((await line.boundingBox())!.width - sum)).toBeLessThanOrEqual(1);
      expect(await line.getAttribute("colspan")).toBe(String(await headers.count()));
    });
  });
}
