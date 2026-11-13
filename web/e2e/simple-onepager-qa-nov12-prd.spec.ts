import { MOCK_SCENARIO_KEY, ONE_PAGER_PLAN_LOOSE_SCENARIO } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA findings of Nov 12, 2026 on a PRD's one-pager (docs/qa/2026-11-12/simple-goalmap.md),
 * driven through the UI against the mock's invented PRDs (Guided setup, Saved carts PRD; the
 * mock's today is Oct 22).
 *
 * OP1: protects = a roadmap item of the plan's When card with no code ("No milestone":
 * Calendar invite sync) carries the "Not in the Ground Truth" flag; fails_when = it shows a bare
 * name. OP5: protects = the When strip's months are as wide as their days, "Oct" a whole month
 * beside "Nov", and Today drawn inside October, right of its name; fails_when = Oct is a sliver,
 * hidden, or its name sits right of the Today pill. OP6: protects = every bar of the strip, the
 * Product manager's lane's too, reads its feature's code with its name, the whole name on hover;
 * fails_when = a bar reads "Pricing pa…" with no code. OP9: protects = "The whole PRD" reads its
 * days month first ("needed by Nov 1, 2026"); fails_when = an ISO day shows. OP10: protects =
 * a feature the whole PRD names with no code (Save cart, Cart on every device, Reminder email)
 * is flagged "Not in the Ground Truth" in "Features by milestone" and in its own detail section;
 * fails_when = a bare name shows. no_claim = the API (the PRD's text is as written).
 */

const DESKTOP = { width: 1440, height: 900 };

async function scenario(page: Page, s: string) {
  await page.context().addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, s] as const);
}

/** Opens a one-pager from Simple's One-pagers list, as a person does. */
async function openOnePager(page: Page, name: RegExp) {
  await login(page);
  await page.goto("/simple");
  await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
  await page.getByTestId("simple-one-pagers").getByRole("link", { name }).first().click();
}

const whole = (page: Page) => page.getByTestId("prd-whole");
const prdSection = (page: Page, key: string) => whole(page).locator(`section[data-prd-sec="${key}"]`);

test.describe("desktop 1440", () => {
  test.use({ viewport: DESKTOP });

  test("OP9: the whole PRD's decisions read their days month first", async ({ page }) => {
    await openOnePager(page, /^Saved carts/);
    const decisions = prdSection(page, "decisions");
    await decisions.scrollIntoViewIfNeeded();
    await expect(decisions).toContainText("needed by Nov 1, 2026", { useInnerText: true });
    await expect(decisions).toContainText("needed by Nov 15, 2026", { useInnerText: true });
    await expect(decisions).not.toContainText(/\d{4}-\d{2}-\d{2}/, { useInnerText: true });
  });

  test("OP10: a feature with no code is flagged in Features by milestone and in Feature detail", async ({ page }) => {
    await openOnePager(page, /^Saved carts/);
    const table = prdSection(page, "brief-items").getByRole("region", { name: "Table" });
    await table.scrollIntoViewIfNeeded();
    for (const name of ["Save cart", "Cart on every device", "Reminder email"]) {
      const cell = table.getByRole("cell").filter({ hasText: name });
      await expect(cell.getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
    }
    // Only the feature column is flagged: the milestones and goals are not features.
    await expect(table.getByTestId("not-in-gt")).toHaveCount(3);
    for (const key of ["feature-save-cart", "feature-sync", "feature-reminder"]) {
      await expect(prdSection(page, key).getByRole("heading").first().getByTestId("not-in-gt")).toBeVisible();
    }
    // A section that is no feature carries no flag.
    await expect(prdSection(page, "milestone-beta").getByTestId("not-in-gt")).toHaveCount(0);
  });

  test("OP1: an item of the When card with no code is flagged", async ({ page }) => {
    await scenario(page, ONE_PAGER_PLAN_LOOSE_SCENARIO);
    await login(page);
    await page.goto("/simple/prds/guided-setup");
    const rows = page.getByRole("region", { name: "Timeline" }).getByTestId("timeline-no-milestone-item");
    await expect(rows).toHaveCount(1);
    await expect(rows.getByRole("button", { name: "Calendar invite sync" })).toBeVisible();
    await expect(rows.getByTestId("not-in-gt")).toHaveText("Not in the Ground Truth");
  });

  test.describe("the When strip", () => {
    test.beforeEach(async ({ page }) => {
      await scenario(page, "simple-plan");
      await openOnePager(page, /^Guided setup/);
      await expect(page.getByRole("region", { name: "Timeline" }).getByTestId("timeline-strip")).toBeVisible();
    });

    test("OP6: every bar reads its code with its name, the PM lane's too", async ({ page }) => {
      const tl = page.getByRole("region", { name: "Timeline" });
      const bars = tl.getByTestId("timeline-bar");
      await expect(bars.first()).toBeVisible();
      for (const t of await bars.allTextContents()) expect(t, "a bar's words lead with a code").toMatch(/^F-\d+[a-z]? [A-Za-z]{3}/);
      const pm = tl.getByTestId("timeline-lane").filter({ hasText: "Product manager's work" }).getByTestId("timeline-bar");
      const pricing = pm.filter({ hasText: /^F-04 Pric/ });
      await expect(pricing).toHaveCount(1);
      await expect(pricing).toHaveAttribute("title", /F-04 Pricing page words/);
    });

    test("OP5: months as wide as their days, Today inside October", async ({ page }) => {
      const axis = page.getByRole("region", { name: "Timeline" }).getByTestId("timeline-axis");
      const month = (m: string) => axis.getByTestId("timeline-month").filter({ hasText: new RegExp(`^${m}$`) });
      await expect(month("Oct")).toHaveCount(1);
      const [oct, nov, dec] = [(await month("Oct").boundingBox())!, (await month("Nov").boundingBox())!, (await month("Dec").boundingBox())!];
      const pill = (await axis.getByText("Today", { exact: true }).boundingBox())!;
      // October (31 days) is about as wide as November (30 days).
      const ratio = (nov.x - oct.x) / (dec.x - nov.x);
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.12);
      // Today (Oct 22) sits inside October, right of its name and left of November.
      expect(oct.x + oct.width).toBeLessThanOrEqual(pill.x);
      expect(pill.x + pill.width / 2).toBeLessThan(nov.x);
    });
  });
});
