import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * panel-menu (fix round, owner's answer Nov 5: parts at any depth, drawn as a tree): an owner
 * builds a three-level tree through the feature panel's Part of… (Alert rules engine > Alert
 * routing by team > Alert history export, invented alert features in the mock's
 * "simple-deciders" scenario), and every role reads it: the panel's full path, the parent's
 * nested parts, and the tree on the Timeline, Gantt, Waterfall and Board, at 1440 and 390.
 *
 * Card pm-tree: protects = a part of a part is allowed; its panel reads "Part of <top> > <parent>";
 * the top's panel nests its parts; every view draws the part under its parent, one level deeper;
 * a feature's own parts (any depth) are never offered as its parent; fails_when = the one-level
 * rule refuses it, the path or the nesting is missing, or a view drops or flattens the part.
 * Card pm-ancestor-link: protects = a part is never a broken link against any ancestor (its
 * grandparent included); fails_when = only the direct parent is excused.
 * Card pm-merge-tree: protects = merging a feature with parts into a feature that is itself a part
 * keeps every part on the roadmap, under the kept feature; fails_when = a part's row disappears.
 * Card pm-restore-part: protects = a part restored from Trash goes back under its parent while
 * that parent is live (at its new place in the tree), else to the top level; fails_when = it
 * comes back under a merged parent, loses its parent, or the restore fails.
 * Card pm-trash-parent: protects = a part whose parent is in Trash reads "Part of <name> (in Trash)"
 * and keeps the dates it took from it; fails_when = it loses its bar or the path.
 * Card pm-cut-part: protects = a cut feature can be made a part and taken out again from its
 * panel, and its parent's panel lists it as cut; fails_when = no Part of… on a cut feature, or
 * the parent does not list it.
 * Card pm-parts-said: protects = deleting, cutting or moving to another goal a feature that has
 * parts says what happens to them at that moment ("Its 1 part stays on the roadmap", "keeps its own
 * goal"), from the panel and from a row's menu; fails_when = the toast says nothing of the parts.
 * Card pm-priorities: protects = Priorities' ranked list and Goal buckets show a part with "part of
 * <parent>", and a part's panel opened from Priorities reads its path; fails_when = no hint, or the
 * panel has no path.
 * Card pm-roles: protects = the panel's Delete follows the row's rule: who decides sees "Delete
 * feature", a commenter "Propose: delete"; a viewer has no menu.
 */

const SIZES = [
  { name: "1440", phone: false, use: { viewport: { width: 1440, height: 900 } } },
  { name: "390", phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
];

const panel = (page: Page) => page.getByTestId("floating-card");
const toasts = (page: Page) => page.getByTestId("toasts");
const row = (page: Page, key: string) => page.locator(`[data-testid="timeline-row"][data-item="${key}"]`);
const boardCard = (page: Page, key: string) => page.locator(`[data-testid="board-card"][data-item="${key}"]`);

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function roadmap(page: Page) {
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function open(page: Page, key: string) {
  await roadmap(page);
  await openRoadmapItem(page, key);
  await expect(panel(page)).toBeVisible();
}

async function menu(page: Page, item: string) {
  await tap(panel(page).getByRole("button", { name: "More actions" }));
  await tap(panel(page).getByRole("menuitem", { name: item }));
}

/** Part of… <parent> from the open panel, as one who decides. */
async function partOf(page: Page, parent: string) {
  await menu(page, "Part of…");
  const form = panel(page).getByTestId("card-parent-edit");
  await form.getByLabel("Part of").selectOption({ label: parent });
  await tap(form.getByRole("button", { name: "Save", exact: true }));
  await expect(toasts(page)).toContainText(`part of ${parent} in your working draft`);
}

async function format(page: Page, f: "timeline" | "gantt" | "board" | "waterfall") {
  await tap(page.getByTestId(`format-${f}`));
  if (f === "board") await expect(page.getByTestId("board")).toBeVisible();
  else await expect(page.getByTestId("simple-chart")).toHaveAttribute("data-format", f);
}

/** The owner's tree, built through the panel: Alert rules engine > Alert routing by team > Alert history export. */
async function buildTree(page: Page) {
  await open(page, "alert-export");
  await partOf(page, "Alert routing by team");
  await open(page, "alert-sso");
  await partOf(page, "Alert rules engine");
}

/** Every view draws the tree: each part under its parent, one level deeper. */
async function treeOnEveryView(page: Page, phone: boolean) {
  await roadmap(page);
  if (!phone) {
    await format(page, "timeline");
    const rows = await page.getByTestId("timeline-row").evaluateAll((rs) => rs.map((r) => [r.getAttribute("data-item"), r.getAttribute("data-depth")]));
    const at = (k: string) => rows.findIndex((r) => r[0] === k);
    expect(at("alert-sso")).toBe(at("alert-rules") + 1);
    expect(at("alert-export")).toBe(at("alert-sso") + 1);
    expect(rows[at("alert-rules")][1]).toBeNull();
    expect(rows[at("alert-sso")][1]).toBe("1");
    expect(rows[at("alert-export")][1]).toBe("2");
  } else {
    // A phone's Timeline lists by quarter; a part shown with its parent sits under it.
    await format(page, "timeline");
    await expect(row(page, "alert-export")).toHaveCount(1);
    await expect(row(page, "alert-sso")).toHaveCount(1);
  }
  for (const f of ["gantt", "waterfall"] as const) {
    await format(page, f);
    const labels = await page.getByTestId("chart-label").evaluateAll((ls) => ls.map((l) => [l.textContent ?? "", l.getAttribute("data-depth")]));
    const at = (t: string) => labels.findIndex((l) => (l[0] ?? "").includes(t));
    expect(at("Alert routing by team"), f).toBe(at("Alert rules engine") + 1);
    expect(at("Alert history export"), f).toBe(at("Alert routing by team") + 1);
    expect(labels[at("Alert routing by team")][1], f).toBe("1");
    expect(labels[at("Alert history export")][1], f).toBe("2");
  }
  await format(page, "board");
  // A part sits under its parent in the same column, one level deeper; never lost.
  for (const k of ["alert-rules", "alert-sso", "alert-export"]) await expect(boardCard(page, k)).toHaveCount(1);
  const sso = page.locator("li").filter({ has: boardCard(page, "alert-sso") }).last();
  const exp = page.locator("li").filter({ has: boardCard(page, "alert-export") }).last();
  const d = async (l: Locator) => Number((await l.getAttribute("data-depth")) ?? 0);
  expect(await d(exp)).toBe((await d(sso)) + 1);
}

/** The part's panel reads the whole path; the top's panel nests its parts. */
async function pathInPanels(page: Page) {
  await open(page, "alert-export");
  await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine > Alert routing by team");
  await tap(panel(page).getByTestId("card-part-of").getByRole("button", { name: "Alert rules engine" }));
  await expect(panel(page).getByTestId("card-name")).toContainText("Alert rules engine");
  const parts = panel(page).getByTestId("card-parts");
  const sso = parts.getByTestId("card-part").filter({ hasText: "Alert routing by team" });
  await expect(sso).toHaveCount(1);
  // Nested: the routing feature's own part is listed inside its entry.
  await expect(sso.getByTestId("card-part").filter({ hasText: "Alert history export" })).toHaveCount(1);
}

for (const size of SIZES)
  test.describe(size.name, () => {
    test.use(size.use);
    test.beforeEach(async ({ context }) => {
      await context.addInitScript(([key]) => localStorage.setItem(key, "simple-deciders"), [MOCK_SCENARIO_KEY] as const);
    });

    test("parts of parts: the owner builds a three-level tree; its path, nesting and every view's tree", async ({ page }) => {
      test.setTimeout(120_000);
      await login(page);
      await buildTree(page);
      // A feature's own parts, at any depth, are shown but cannot be picked as its parent (never its own ancestor).
      await open(page, "alert-rules");
      await menu(page, "Part of…");
      const pick = panel(page).getByTestId("card-parent-edit").getByLabel("Part of");
      await expect(pick.locator("option", { hasText: "Alert routing by team" })).toBeDisabled();
      await expect(pick.locator("option", { hasText: "Alert history export" })).toBeDisabled();
      await expect(pick.locator("option", { hasText: "Mobile alert push" })).toBeEnabled();
      await pathInPanels(page);
      await treeOnEveryView(page, size.phone);
    });

    // The published tree ("parts-tree" scenario), read by the owner, an approver who decides the
    // alerts track, a commenter and a viewer.
    test.describe("a published tree", () => {
      test.beforeEach(async ({ context }) => {
        await context.addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      });
      for (const who of ["admin@example.com", "avery.lane@example.com", "commenter@example.com", "viewer@example.com"])
        test(`${who} reads the path, the nesting and every view's tree; the panel's Delete follows the row's`, async ({ page }) => {
          test.setTimeout(90_000);
          await login(page, who);
          await pathInPanels(page);
          if (who === "viewer@example.com") await expect(panel(page).getByRole("button", { name: "More actions" })).toHaveCount(0);
          else {
            // Who decides deletes; others propose it, as a row's Delete.
            await tap(panel(page).getByRole("button", { name: "More actions" }));
            await expect(panel(page).getByRole("menuitem", { name: who === "commenter@example.com" ? "Propose: delete" : "Delete feature" })).toBeVisible();
            await page.keyboard.press("Escape");
          }
          await treeOnEveryView(page, size.phone);
        });
    });

    test("a part of a part is never a broken link against an ancestor", async ({ page }) => {
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      await login(page);
      await roadmap(page);
      await format(page, "board");
      // Weekly alert digest depends on Alert rules engine and starts before it ends: broken.
      const dependencyLine = () => boardCard(page, "alert-digest").getByTestId("board-broken").filter({ hasText: "which it depends on" });
      await expect(boardCard(page, "alert-digest")).toHaveAttribute("data-broken", "true");
      await expect(dependencyLine()).toHaveCount(1);
      await open(page, "alert-digest");
      await partOf(page, "Alert routing by team");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine > Alert routing by team");
      // Now its grandparent: no broken link against it. (Its end past its Beta milestone stays
      // red: train AS counts that as a broken link too, pre-demo QA S-5.)
      await roadmap(page);
      await format(page, "board");
      await expect(dependencyLine()).toHaveCount(0);
    });

    test("merging a feature that has parts into a feature that is itself a part keeps every part, under the kept one", async ({ page }) => {
      await login(page);
      await open(page, "alert-export");
      await partOf(page, "Alert routing by team");
      await open(page, "alert-mobile");
      await partOf(page, "Alert rules engine");
      await open(page, "alert-sso");
      await menu(page, "Merge into…");
      const form = panel(page).getByTestId("card-merge-edit");
      await form.getByLabel("Merge into").selectOption({ label: "Mobile alert push" });
      await tap(form.getByRole("button", { name: "Merge", exact: true }));
      await expect(toasts(page)).toContainText("Merged 'Alert routing by team' into Mobile alert push in your working draft");
      // The merged feature's part now sits under the kept one.
      await open(page, "alert-export");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine > Mobile alert push");
      if (!size.phone) {
        await roadmap(page);
        const rows = await page.getByTestId("timeline-row").evaluateAll((rs) => rs.map((r) => [r.getAttribute("data-item"), r.getAttribute("data-depth")]));
        const at = (k: string) => rows.findIndex((r) => r[0] === k);
        expect(at("alert-export")).toBe(at("alert-mobile") + 1);
        expect(rows[at("alert-export")][1]).toBe("2");
      }
    });

    test("a part restored from Trash goes back under its parent while that is live, else to the top level", async ({ page }) => {
      test.setTimeout(90_000);
      await login(page);
      await open(page, "alert-export");
      await partOf(page, "Alert routing by team");
      await menu(page, "Delete feature");
      await expect(toasts(page)).toContainText("Moved Alert history export to Trash.");
      // Meanwhile its parent moves: it becomes a part of Alert rules engine.
      await open(page, "alert-sso");
      await partOf(page, "Alert rules engine");
      await page.goto("/settings/trash");
      await tap(page.getByRole("button", { name: "Restore Alert history export" }));
      await expect(page.getByTestId("trash-entry").filter({ hasText: "Alert history export" })).toHaveCount(0);
      await open(page, "alert-export");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine > Alert routing by team");

      // Deleted again, and its parent merged away meanwhile: it comes back at the top level.
      await menu(page, "Delete feature");
      await expect(toasts(page)).toContainText("Moved Alert history export to Trash.");
      await open(page, "alert-sso");
      await menu(page, "Merge into…");
      const form = panel(page).getByTestId("card-merge-edit");
      await form.getByLabel("Merge into").selectOption({ label: "Mobile alert push" });
      await tap(form.getByRole("button", { name: "Merge", exact: true }));
      await expect(toasts(page)).toContainText("Merged 'Alert routing by team' into Mobile alert push in your working draft");
      await page.goto("/settings/trash");
      await tap(page.getByRole("button", { name: "Restore Alert history export" }));
      await expect(page.getByTestId("trash-entry").filter({ hasText: "Alert history export" })).toHaveCount(0);
      await open(page, "alert-export");
      await expect(panel(page).getByTestId("card-name")).toContainText("Alert history export");
      await expect(panel(page).getByTestId("card-part-of")).toHaveCount(0);
    });

    test("a part whose parent is in Trash reads 'Part of <name> (in Trash)' and keeps its dates", async ({ page }) => {
      await login(page);
      await open(page, "alert-sso");
      await partOf(page, "Alert rules engine");
      await open(page, "alert-rules");
      await menu(page, "Delete feature");
      await tap(page.getByRole("alertdialog", { name: "Delete Alert rules engine?" }).getByRole("button", { name: "Delete" }));
      await expect(toasts(page)).toContainText("Moved Alert rules engine to Trash.");
      await open(page, "alert-sso");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine (in Trash)");
      await expect(row(page, "alert-sso").getByTestId("timeline-bar").first()).toBeVisible();
    });

    test("a cut feature is made a part from its panel, listed as cut in its parent's, and taken out again", async ({ page }) => {
      await login(page);
      await roadmap(page);
      await format(page, "board");
      await tap(boardCard(page, "setup-tour"));
      await expect(panel(page).getByTestId("item-cut")).toBeVisible();
      await partOf(page, "Setup checklist");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Setup checklist");
      await tap(panel(page).getByTestId("card-part-of").getByRole("button", { name: "Setup checklist" }));
      await expect(panel(page).getByTestId("card-parts").getByTestId("card-part").filter({ hasText: "In-app tour" })).toContainText("(cut)");
      await tap(panel(page).getByTestId("card-parts").getByRole("button", { name: "In-app tour" }));
      await menu(page, "Part of…");
      const form = panel(page).getByTestId("card-parent-edit");
      await form.getByLabel("Part of").selectOption({ label: "Not a part of another feature" });
      await tap(form.getByRole("button", { name: "Save", exact: true }));
      await expect(toasts(page)).toContainText("Took 'In-app tour' out of Setup checklist");
      await expect(panel(page).getByTestId("card-part-of")).toHaveCount(0);
    });

    test("deleting, cutting or moving a feature that has parts says what happens to its parts", async ({ page }) => {
      test.setTimeout(90_000);
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      await login(page);
      await open(page, "alert-rules");
      // Another goal: its part keeps its own.
      await tap(panel(page).getByRole("button", { name: "Change the goal" }));
      const goal = panel(page).getByTestId("card-goal-edit").getByLabel("Goal");
      const now = await goal.inputValue();
      const other = (await goal.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).find((v) => v && v !== now)!;
      await goal.selectOption(other);
      await tap(panel(page).getByTestId("card-goal-edit").getByRole("button", { name: "Save" }));
      await expect(toasts(page)).toContainText("Its 1 part keeps its own goal.");
      // Cut: its part stays on the roadmap, said beside Cut before Save, and again after.
      await tap(panel(page).getByRole("button", { name: "Change the status" }));
      const status = panel(page).getByTestId("card-status-edit");
      await expect(status.getByTestId("pick-note")).toHaveCount(0);
      await status.getByLabel("Status").selectOption("cut");
      await expect(status.getByTestId("pick-note")).toHaveText("Its 1 part stays on the roadmap.");
      await tap(status.getByRole("button", { name: "Save" }));
      await expect(toasts(page)).toContainText("Its 1 part stays on the roadmap.");
      // To Trash: asked first with the count (Cancel keeps it), said again once done.
      await menu(page, "Delete feature");
      const ask = page.getByRole("alertdialog", { name: "Delete Alert rules engine?" });
      await expect(ask).toContainText("Its 1 part stays on the roadmap.");
      await tap(ask.getByRole("button", { name: "Cancel" }));
      await expect(ask).toHaveCount(0);
      await expect(panel(page).getByTestId("card-name")).toContainText("Alert rules engine");
      await menu(page, "Delete feature");
      await tap(ask.getByRole("button", { name: "Delete" }));
      await expect(toasts(page)).toContainText("Moved Alert rules engine to Trash. Its 1 part stays on the roadmap.");
      await open(page, "alert-sso");
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine (in Trash)");
    });

    test("Delete from Priorities counts a feature's parts the list does not show", async ({ page }) => {
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      await login(page);
      // Its one part cut: no longer ranked, still its part.
      await open(page, "alert-sso");
      await tap(panel(page).getByRole("button", { name: "Change the status" }));
      await panel(page).getByTestId("card-status-edit").getByLabel("Status").selectOption("cut");
      await tap(panel(page).getByTestId("card-status-edit").getByRole("button", { name: "Save" }));
      await expect(panel(page).getByTestId("item-cut")).toBeVisible();
      await page.goto("/simple/priorities");
      const ranked = (key: string) => page.locator(`[data-testid="prio-row"][data-code="${key}"]`);
      await expect(ranked("alert-sso")).toHaveCount(0);
      await tap(ranked("alert-rules").getByRole("button", { name: /^More for / }));
      await tap(page.getByRole("menuitem", { name: "Delete feature" }));
      const ask = page.getByRole("alertdialog", { name: "Delete Alert rules engine?" });
      await expect(ask).toContainText("Its 1 part stays on the roadmap.");
      await tap(ask.getByRole("button", { name: "Cancel" }));
      await expect(ranked("alert-rules")).toBeVisible();
    });

    test("Part of shows a feature's own parts but cannot pick them, and says why", async ({ page }) => {
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      await login(page);
      await open(page, "alert-rules");
      await menu(page, "Part of…");
      const pick = panel(page).getByTestId("card-parent-edit").getByLabel("Part of");
      const own = pick.locator("option", { hasText: "Alert routing by team" });
      await expect(own).toBeDisabled();
      await expect(own).toHaveAttribute("title", "Alert rules engine cannot be part of Alert routing by team: Alert routing by team is already one of its parts");
      await expect(pick.locator("option", { hasText: "Mobile alert push" })).toBeEnabled();
    });

    test("Priorities shows a part with its parent, and a part's panel from Priorities reads its path", async ({ page }) => {
      await page.context().addInitScript(([key]) => localStorage.setItem(key, "parts-tree"), [MOCK_SCENARIO_KEY] as const);
      await login(page);
      await page.goto("/simple/priorities");
      const ranked = (key: string) => page.locator(`[data-testid="prio-row"][data-code="${key}"]`);
      await expect(ranked("alert-sso").getByTestId("prio-part-of")).toHaveText("part of Alert rules engine");
      await expect(ranked("alert-export").getByTestId("prio-part-of")).toHaveText("part of Alert routing by team");
      await expect(ranked("alert-rules").getByTestId("prio-part-of")).toHaveCount(0);
      await tap(ranked("alert-export").getByTestId("prio-title"));
      await expect(panel(page).getByTestId("card-part-of")).toHaveText("Part of Alert rules engine > Alert routing by team");
      // Made a part from its panel there: its row and its goal's bucket say so at once.
      await tap(page.getByTestId("prio-title").filter({ hasText: "Mobile alert push" }));
      await partOf(page, "Alert rules engine");
      await expect(ranked("alert-mobile").getByTestId("prio-part-of")).toHaveText("part of Alert rules engine");
      await page.goto("/simple/priorities?tab=buckets");
      const listed = page.getByTestId("bucket-features").locator("li").filter({ hasText: "Mobile alert push" });
      await expect(listed.getByTestId("prio-part-of")).toHaveText("part of Alert rules engine");
    });
  });
