import { expect, test, type Page } from "./test";

import { DRAFT_LAYER_SCENARIO, MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/**
 * RP2 'Draft layer on roadmap' (the owner's pick, Nov 4): Simple › Roadmap shows each PRD whose run
 * dated items not approved yet in a draft layer above its chart, one card per PRD, its items
 * hatched on the card's own months; Show drafts hides them all and is remembered; the PRD filter
 * lists each as "<PRD> (draft)"; a draft item opens the feature panel with its Draft line, and
 * Leave out takes it off the run's draft; approving the PRD puts its items on the roadmap.
 * Against the mock (web/lib/api/mock/meeting-draft.ts draftPrdsOut), invented data: Saved carts and
 * Team workspaces in draft, Online deposits (its PRD replaced) and Clinic outreach (its run
 * cancelled) left out.
 *
 * Test cards (protects / fails_when / no_claim):
 * - desktop: protects=frames rp2-a-rest, rp2-a-open, rp2-a-done at 1440 and 1512, light and dark;
 *   fails_when=the layer, a card, a hatched bar, the switch, the "(draft)" entry or the panel's
 *   Draft line is missing, a replaced or cancelled draft shows, Show drafts is not remembered, or
 *   Leave out leaves the bar; no_claim=the real API (api/tests/test_simple_roadmap_draft_prds.py).
 *   The panel starts under the roadmap's toolbar; fails_when=it covers the toolbar's right end.
 * - approval: protects=approving the PRD takes its card off the layer and its items onto the
 *   roadmap, less the one left out; fails_when=the card stays, the items are not on the roadmap,
 *   or the left-out item is.
 * - commenter, viewer: protects=they read the draft panel with no Change dates or Leave out
 *   (approvers and up, the owner's answer); fails_when=either button shows.
 * - phone 390: protects=frame rp2-a-rest-390; fails_when=the layer is not above the roadmap's
 *   chart, a row is missing, or the page scrolls sideways.
 */

const CARTS = ["Save a cart for later", "Carts kept across devices", "Price-drop note on saved carts", "Shared carts for teams", "Saved-cart reminder emails", "Turn a cart into a quote"];

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

async function openRoadmap(page: Page, role?: "viewer" | "commenter") {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, DRAFT_LAYER_SCENARIO]);
  if (role) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_ROLE_KEY, role]);
  await login(page);
  await page.goto("/simple/roadmap");
  const layer = page.getByRole("region", { name: "Draft plans" });
  await expect(layer).toBeVisible();
  return layer;
}

const bar = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(`^${title}, .*, draft, not approved$`) });

for (const scheme of ["light", "dark"] as const) {
  for (const width of [1440, 1512]) {
    test.describe(`desktop ${width} ${scheme}`, () => {
      test.use({ viewport: { width, height: width === 1440 ? 900 : 982 }, colorScheme: scheme });

      test("the layer shows each draft PRD; the switch, the filter and the panel work on it", async ({ page }) => {
        const layer = await openRoadmap(page);
        await expect(layer.getByRole("heading", { name: "Saved carts · draft" })).toBeVisible();
        await expect(layer.getByRole("heading", { name: "Team workspaces · draft" })).toBeVisible();
        await expect(layer).not.toContainText("Deposit at booking");
        await expect(layer).not.toContainText("Outreach letters");
        await expect(layer.getByText("Not approved yet").first()).toBeVisible();
        for (const t of CARTS) await expect(bar(page, t)).toBeVisible();
        await expect(bar(page, "Save a cart for later")).toHaveAccessibleName("Save a cart for later, Nov 9 – Dec 18, draft, not approved");
        // The layer sits above the roadmap's own chart.
        const chartTop = (await page.getByText("Add an item").first().boundingBox())!.y;
        expect((await layer.boundingBox())!.y).toBeLessThan(chartTop);
        await shot(page, `rp2-a-rest-${width}-${scheme}`);

        // Each card folds away on its own.
        await layer.getByRole("button", { name: "Team workspaces · draft" }).click();
        await expect(layer.getByRole("button", { name: "Team workspaces · draft" })).toHaveAttribute("aria-expanded", "false");
        await expect(bar(page, "Invite a whole team")).toHaveCount(0);
        await expect(bar(page, "Save a cart for later")).toBeVisible();

        // Show drafts hides them all, and is remembered for this person.
        await layer.getByRole("checkbox", { name: "Show drafts" }).uncheck();
        await expect(bar(page, "Save a cart for later")).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole("region", { name: "Draft plans" }).getByRole("checkbox", { name: "Show drafts" })).not.toBeChecked();
        await expect(bar(page, "Save a cart for later")).toHaveCount(0);
        await page.getByRole("region", { name: "Draft plans" }).getByRole("checkbox", { name: "Show drafts" }).check();
        await expect(bar(page, "Save a cart for later")).toBeVisible();

        // The PRD filter lists the draft PRD; picked, only its draft shows and the chart has nothing of it.
        const prd = page.getByRole("combobox", { name: "PRD" });
        await expect(prd.locator("option", { hasText: "Saved carts (draft)" })).toHaveCount(1);
        await expect(prd.locator("option", { hasText: "Online deposits" })).toHaveCount(0);
        await prd.selectOption({ label: "Saved carts (draft)" });
        await expect(layer.getByRole("status")).toHaveText("Showing Saved carts only: its 6 items are a draft, hatched until the PRD is approved. Nothing of it is on the approved roadmap yet.");
        await expect(layer.getByRole("heading", { name: "Team workspaces · draft" })).toHaveCount(0);
        await expect(page.getByText("Nothing matches these filters")).toBeVisible();
        await shot(page, `rp2-a-done-${width}-${scheme}`);
        await prd.selectOption({ label: "All" });

        // A draft item opens the feature panel with its Draft line.
        await bar(page, "Price-drop note on saved carts").click();
        const panel = page.getByTestId("item-panel");
        await expect(panel).toHaveAttribute("aria-label", "Price-drop note on saved carts");
        await expect(panel.getByText("Draft", { exact: true })).toBeVisible();
        await expect(panel).toContainText("Jan 11 – Feb 12 · Priya Natarajan");
        await expect(panel).toContainText("Dates from Saved carts' run (engineering dates). Not approved: it joins the roadmap when the PRD is approved.");
        // The panel starts under the toolbar: its right end (Needs a decision) stays in sight.
        const actions = (await page.getByTestId("roadmap-actions").boundingBox())!;
        await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(actions.y + actions.height);
        await shot(page, `rp2-a-open-${width}-${scheme}`);

        // Leave out takes it off the run's draft, and so off the layer.
        await panel.getByRole("button", { name: "Leave out" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Leave out", exact: true }).click();
        await expect(page.getByTestId("item-panel")).toHaveCount(0);
        await expect(bar(page, "Price-drop note on saved carts")).toHaveCount(0);
        await expect(bar(page, "Shared carts for teams")).toBeVisible();
      });
    });
  }
}

test.describe("approval", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("approving the PRD takes its card off the layer and its items onto the roadmap", async ({ page }) => {
    const layer = await openRoadmap(page);
    await expect(layer.getByRole("heading", { name: "Saved carts · draft" })).toBeVisible();
    // Left out on the layer: approval does not put it on the roadmap.
    await bar(page, "Turn a cart into a quote").click();
    await page.getByTestId("item-panel").getByRole("button", { name: "Leave out" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Leave out", exact: true }).click();
    await expect(bar(page, "Turn a cart into a quote")).toHaveCount(0);
    await page.goto("/documents/saved-carts/publish");
    const publish = page.getByTestId("publish-button");
    await expect(publish).toBeEnabled();
    await publish.click();
    await page.getByRole("dialog", { name: /^Publish v\d+\?$/ }).getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByTestId("published-chip")).toBeVisible();
    await page.goto("/simple/roadmap");
    await expect(layer.getByRole("heading", { name: "Team workspaces · draft" })).toBeVisible();
    await expect(layer.getByRole("heading", { name: "Saved carts · draft" })).toHaveCount(0);
    const prd = page.getByRole("combobox", { name: "PRD" });
    await expect(prd.locator("option", { hasText: "Saved carts (draft)" })).toHaveCount(0);
    await prd.selectOption({ label: "Saved carts" });
    await expect(page.getByRole("button", { name: /^Save a cart for later, / }).first()).toBeVisible();
    await expect(page.getByText("Turn a cart into a quote")).toHaveCount(0);
  });
});

for (const role of ["commenter", "viewer"] as const) {
  test.describe(`${role}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test(`a ${role} reads the draft panel without Change dates or Leave out`, async ({ page }) => {
      const layer = await openRoadmap(page, role);
      await expect(layer.getByRole("heading", { name: "Saved carts · draft" })).toBeVisible();
      await bar(page, "Price-drop note on saved carts").click();
      const panel = page.getByTestId("item-panel");
      await expect(panel).toContainText("Jan 11 – Feb 12 · Priya Natarajan");
      await expect(panel.getByText("Draft", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Change dates" })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Leave out" })).toHaveCount(0);
    });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`phone 390 ${scheme}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: scheme });

    test("the draft list comes before the roadmap's chart, nothing scrolls sideways", async ({ page }) => {
      const layer = await openRoadmap(page);
      for (const t of CARTS) await expect(bar(page, t)).toBeVisible();
      await expect(layer).toContainText("Nov 9 – Dec 18");
      const add = page.getByRole("button", { name: "Add", exact: true });
      expect((await layer.boundingBox())!.y).toBeLessThan((await add.boundingBox())!.y);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(wide).toBeLessThanOrEqual(0);
      await shot(page, `rp2-a-rest-390-${scheme}`);
      await bar(page, "Price-drop note on saved carts").click();
      await expect(page.getByTestId("item-panel")).toContainText("Jan 11 – Feb 12 · Priya Natarajan");
    });
  });
}
