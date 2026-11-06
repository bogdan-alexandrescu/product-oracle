import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * panel-menu: the feature panel's header menu (⋯ More actions) deletes the feature to Trash with
 * Undo, merges it into another feature, and makes it a part of another feature, each with Undo.
 * An owner and an approver who decides the roadmap (the mock's alerts track owner) act; a
 * commenter's Delete, Merge and Part of are proposals; a viewer has no menu. Driven through the
 * Simple roadmap's Timeline at 1440 and 390, light and dark, against the mock's default scenario
 * (invented alert features).
 *
 * Card pm-delete: protects = Delete feature in the panel's menu moves it to Trash, the panel
 * closes, the row leaves the roadmap and Undo brings it back; fails_when = no Delete in the menu,
 * the panel stays open or the row stays.
 * Card pm-merge: protects = Merge into… marks it merged ("Merged into <name>" on its row and
 * panel), the kept feature takes its dependencies, and Undo restores it; fails_when = no Merge
 * into…, the row stays live, or the kept feature lacks the dependency.
 * Card pm-parts: protects = Part of… shows "Part of <name>" in the panel, the parent's panel lists
 * its parts, the part's row sits right under its parent's, and Undo takes it out again;
 * fails_when = any of those missing.
 * Card pm-roles: protects = a commenter's actions are proposals and change nothing yet; a viewer
 * has no menu.
 */

const SIZES = [
  { name: "1440", phone: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];
const SCHEMES = ["light", "dark"] as const;

const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");
const row = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function open(page: Page, email: string | undefined, key: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function menu(page: Page, item: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: item }));
}

async function undo(page: Page) {
  await tap(toasts(page).getByRole("button", { name: "Undo" }).last());
}

for (const size of SIZES)
  for (const scheme of SCHEMES)
    test.describe(`${size.name} ${scheme}`, () => {
      test.use(size.use);
      test.beforeEach(async ({ context, page }) => {
        await context.addInitScript(
          ([themeKey, theme, scenarioKey]) => {
            localStorage.setItem(themeKey, theme);
            localStorage.removeItem(scenarioKey);
          },
          [THEME_KEY, scheme, MOCK_SCENARIO_KEY] as const,
        );
        await page.emulateMedia({ colorScheme: scheme });
      });

      test("an owner deletes a feature from its panel to Trash; the panel closes and Undo brings it back", async ({ page }) => {
        await open(page, undefined, "alert-export");
        if (scheme === "dark") await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await menu(page, "Delete feature");
        await expect(toasts(page)).toContainText("Moved Alert history export to Trash.");
        await expect(panel(page)).toHaveCount(0);
        await expect(row(page, "alert-export")).toHaveCount(0);
        await undo(page);
        await expect(toasts(page)).toContainText("Undone: Alert history export and its links are back.");
        await expect(row(page, "alert-export")).toHaveCount(1);
      });

      test("an approver merges a feature into another: it says where it went, the kept one takes its dependency, Undo restores it", async ({ page }) => {
        // The "simple-deciders" scenario: this approver owns the alerts track, so decides its features.
        await page.context().addInitScript(([key]) => localStorage.setItem(key, "simple-deciders"), [MOCK_SCENARIO_KEY] as const);
        await open(page, "avery.lane@example.com", "alert-sso");
        await expect(panel(page).getByTestId("card-depends")).toContainText("Alert history export");
        await menu(page, "Merge into…");
        const form = panel(page).getByTestId("card-merge-edit");
        await form.getByLabel("Merge into").selectOption({ label: "Mobile alert push" });
        await tap(form.getByRole("button", { name: "Merge", exact: true }));
        await expect(toasts(page)).toContainText("Merged 'Alert routing by team' into Mobile alert push in your working draft");
        await expect(panel(page).getByTestId("item-merged")).toContainText("Merged into");
        await expect(panel(page).getByTestId("item-merged")).toContainText("Mobile alert push");
        if (!size.phone) await expect(row(page, "alert-sso").getByTestId("row-merged")).toContainText("Merged into");
        // The kept feature now depends on what the merged one did.
        await tap(panel(page).getByTestId("item-merged").getByRole("button", { name: /Mobile alert push/ }));
        await expect(panel(page).getByTestId("card-name")).toContainText("Mobile alert push");
        await expect(panel(page).getByTestId("card-depends")).toContainText("Alert history export");
        await undo(page);
        await expect(toasts(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
        if (!size.phone) await expect(row(page, "alert-sso").getByTestId("row-merged")).toHaveCount(0);
        await expect(panel(page).getByTestId("card-depends")).not.toContainText("Alert history export");
      });

      test("an owner makes a feature part of another: both panels say so, it sits under its parent, Undo takes it out", async ({ page }) => {
        await open(page, undefined, "alert-export");
        await menu(page, "Part of…");
        const form = panel(page).getByTestId("card-parent-edit");
        await form.getByLabel("Part of").selectOption({ label: "Alert rules engine" });
        await tap(form.getByRole("button", { name: "Save", exact: true }));
        await expect(toasts(page)).toContainText("Made 'Alert history export' part of Alert rules engine in your working draft");
        await expect(panel(page).getByTestId("card-part-of")).toContainText("Part of Alert rules engine");
        if (!size.phone) {
          // The part's row comes right after its parent's.
          const keys = await page.getByTestId("timeline-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-item")));
          expect(keys.indexOf("alert-export")).toBe(keys.indexOf("alert-rules") + 1);
        }
        await tap(panel(page).getByTestId("card-part-of").getByRole("button", { name: "Alert rules engine" }));
        await expect(panel(page).getByTestId("card-name")).toContainText("Alert rules engine");
        await expect(panel(page).getByTestId("card-parts")).toContainText("Alert history export");
        await undo(page);
        await expect(panel(page).getByTestId("card-parts")).toHaveCount(0);
      });

      test("a commenter's Delete, Merge into and Part of are proposals; nothing changes yet", async ({ page }) => {
        await open(page, "commenter@example.com", "alert-export");
        await menu(page, "Part of…");
        let form = panel(page).getByTestId("card-parent-edit");
        await form.getByLabel("Part of").selectOption({ label: "Alert rules engine" });
        await tap(form.getByRole("button", { name: "Propose: save" }));
        await expect(toasts(page)).toContainText("proposed");
        await expect(panel(page).getByTestId("card-part-of")).toHaveCount(0);

        await menu(page, "Merge into…");
        form = panel(page).getByTestId("card-merge-edit");
        await form.getByLabel("Merge into").selectOption({ label: "Mobile alert push" });
        await tap(form.getByRole("button", { name: "Propose: merge" }));
        await expect(toasts(page).getByText(/Merged 'Alert history export' into Mobile alert push proposed/)).toBeVisible();
        await expect(panel(page).getByTestId("item-merged")).toHaveCount(0);

        // As a row's Delete: who may not decide proposes it.
        await menu(page, "Propose: delete");
        await expect(toasts(page)).toContainText("Sent: delete Alert history export. Its decider decides.");
        await expect(panel(page)).toBeVisible();
        await expect(row(page, "alert-export")).toHaveCount(1);
      });

      test("a viewer's panel has no menu", async ({ page }) => {
        await open(page, "viewer@example.com", "alert-export");
        await expect(panel(page).getByTestId("card-name")).toContainText("Alert history export");
        await expect(panel(page).getByRole("button", { name: "More actions" })).toHaveCount(0);
      });
    });
