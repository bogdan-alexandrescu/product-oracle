import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The Simple roadmap's Roadmap filter (#723): "All roadmaps" or one roadmap the person may
 * read, beside PRD / Goal / Track and remembered per person. One roadmap chosen: the board
 * shows only its items, the header names it, quick add (the field's chip on a desktop, the
 * sheet on a phone) and the Key dates editor send that roadmap's id. All roadmaps (more than
 * one): quick add asks which roadmap (a select) and sends nothing until one is chosen; the
 * Key dates editor lists the key dates per roadmap and adding one asks which roadmap. Driven
 * through the UI against the mock (web/lib/api/mock/simple-roadmap.ts, simple-changes.ts):
 * invented roadmaps "Alerts roadmap" (key date Customer conference, Nov 14), "Onboarding
 * roadmap" (Board meeting, Dec 15) and the approvers-only "Pricing roadmap"; desktop
 * (1366x820) and phone (390x844), light and dark, as an owner, a commenter and a viewer.
 * Each test's card is in its comment.
 */

const ROADMAP = "/simple/roadmap";
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const COMMENTER = "commenter@example.com";
const VIEWER = "viewer@example.com";

const boardCard = (page: Page, key: string): Locator => page.locator(`[data-testid="board-card"][data-item="${key}"]`);
const editor = (page: Page): Locator => page.getByTestId("key-dates-editor");
const kdRow = (scope: Locator, name: string): Locator => scope.locator(`[data-testid="key-date-row"][data-name="${name}"]`);
const group = (page: Page, roadmap: string): Locator => editor(page).locator(`[data-testid="key-dates-group"][data-roadmap="${roadmap}"]`);
const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });

async function openBoard(page: Page) {
  await page.goto(ROADMAP);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await page.getByTestId("format-board").click();
  await expect(page.getByTestId("board")).toBeVisible();
  // qa-shell-24: a phone's pickers sit behind the Filters button.
  const toggle = page.getByTestId("filters-toggle");
  if (await toggle.isVisible()) await toggle.click();
}

async function pick(page: Page, roadmap: string) {
  await page.getByTestId("filter-roadmap").selectOption({ label: roadmap });
  await expect(page.getByTestId("roadmap-scope")).toHaveText(roadmap);
}

/** Quick add with the where (and, when asked, the roadmap) chosen: the desktop field's chip
 * then Enter opens the form; a phone's Add opens the sheet. */
async function quickAdd(page: Page, phone: boolean, title: string, where: string, button: "Add" | "Propose", roadmap?: string) {
  if (phone) {
    await page.getByTestId("quick-add-open").click();
  } else {
    await page.getByLabel("Add an item").fill(title);
    if (roadmap) {
      // Asked, and nothing goes until a roadmap is chosen.
      await expect(page.getByTestId("quick-add-chip")).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByTestId("quick-add-chip")).toHaveAccessibleName("Choose a roadmap first");
      await page.getByTestId("quick-add-roadmap").selectOption({ label: roadmap });
    } else {
      await expect(page.getByTestId("quick-add-roadmap")).toHaveCount(0);
    }
    await expect(page.getByTestId("quick-add-chip")).toHaveAttribute("aria-disabled", "false");
    // QA2 qa-simple-roadmap-10: a desktop's Enter adds at once (no sheet repeating the row's
    // fields); a place other than the first is chosen by dragging the chip onto it.
    const chip = page.getByTestId("quick-add-chip");
    const target = page.locator(`[data-add-where="horizon:${where.toLowerCase()}"]`).first();
    await page.evaluate(() => window.scrollTo(0, 0));
    const from = (await chip.boundingBox())!;
    const to = (await target.boundingBox())!;
    const bottom = (page.viewportSize()?.height ?? 800) - 12;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, Math.min(to.y + 40, bottom), { steps: 12 });
    await page.mouse.up();
    return;
  }
  const sheet = page.getByRole("dialog", { name: "Add an item" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Where").selectOption({ label: where });
  if (roadmap && phone) {
    await expect(sheet.getByRole("button", { name: button, exact: true })).toBeDisabled();
    await sheet.getByLabel("Roadmap").selectOption({ label: roadmap });
  } else if (!roadmap) {
    await expect(sheet.getByLabel("Roadmap")).toHaveCount(0);
  }
  await sheet.getByRole("button", { name: button, exact: true }).click();
  await expect(sheet).toBeHidden();
}

for (const [where, use] of [
  ["desktop", {}],
  ["phone", PHONE],
] as const) {
  const phone = where === "phone";
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${where}, ${scheme}`, () => {
      test.use({ ...use, colorScheme: scheme });

      /**
       * Card roadmap-filter-one: protects = an owner picks one roadmap: the header names
       * it, the board shows only its items, quick add (named "to <roadmap>", no roadmap
       * select) adds the item to that roadmap, the Key dates editor is that roadmap's and
       * a key date added there is absent from the other roadmap; the pick is remembered
       * after a reload; fails_when = other roadmaps' items show, quick add or a key date
       * lands on another roadmap, or the pick is forgotten; no_claim = the API's 404 on an
       * unreadable roadmap (api/tests/test_simple_roadmap_filter_api.py).
       */
      test("one roadmap: its items only; quick add and key dates go to it; remembered", async ({ page }) => {
        await login(page);
        await openBoard(page);
        await expect(page.getByTestId("roadmap-scope")).toHaveText("All roadmaps");
        await expect(boardCard(page, "alert-rules")).toHaveCount(1);
        await pick(page, "Onboarding roadmap");
        await expect(boardCard(page, "alert-rules")).toHaveCount(0);
        await expect(boardCard(page, "setup-checklist")).toHaveCount(1);
        await expect(boardCard(page, "price-tiers")).toHaveCount(0);
        if (!phone) await expect(page.getByTestId("quick-add-target")).toHaveText("to Onboarding roadmap");
        await quickAdd(page, phone, "Referral rewards", "Next", "Add");
        await expect(toastWith(page, "Added Referral rewards as a draft")).toBeVisible();
        await expect(boardCard(page, "referral-rewards")).toHaveCount(1);

        await page.getByTestId("key-dates-open").click();
        await expect(editor(page).getByTestId("key-dates-of")).toHaveText(" · Onboarding roadmap");
        await expect(kdRow(editor(page), "Board meeting")).toBeVisible();
        await expect(kdRow(editor(page), "Customer conference")).toHaveCount(0);
        await expect(editor(page).getByTestId("key-date-add-roadmap")).toHaveCount(0);
        await editor(page).getByLabel("New key date's name").fill("Launch week");
        await editor(page).getByLabel("New key date's day").fill("2026-12-03");
        await editor(page).getByRole("button", { name: "Add", exact: true }).click();
        await expect(toastWith(page, "Added the key date 'Launch week' in your working draft")).toBeVisible();
        await expect(kdRow(editor(page), "Launch week")).toBeVisible();
        await page.keyboard.press("Escape");

        await pick(page, "Alerts roadmap");
        await expect(boardCard(page, "referral-rewards")).toHaveCount(0);
        await expect(boardCard(page, "alert-rules")).toHaveCount(1);
        await page.getByTestId("key-dates-open").click();
        await expect(kdRow(editor(page), "Customer conference")).toBeVisible();
        await expect(kdRow(editor(page), "Launch week")).toHaveCount(0);
        await page.keyboard.press("Escape");

        // Remembered: opening the roadmap again brings the person's last pick back.
        await openBoard(page);
        await expect(page.getByTestId("roadmap-scope")).toHaveText("Alerts roadmap");
        await expect(page.getByTestId("filter-roadmap")).toHaveValue(/[0-9a-f-]{36}/);
        await expect(boardCard(page, "setup-checklist")).toHaveCount(0);
      });

      /**
       * Card roadmap-filter-all: protects = with All roadmaps quick add asks which roadmap
       * (nothing is sent until one is chosen) and the item lands on the one chosen; the Key
       * dates button lists key dates per roadmap and adding one asks which roadmap, landing
       * there; fails_when = quick add or a key date guesses a roadmap, or lands on another;
       * no_claim = Oracle's drafting of the added item (simple-additions.spec.ts).
       */
      test("all roadmaps: quick add and key dates ask which roadmap", async ({ page }) => {
        await login(page);
        await openBoard(page);
        await expect(page.getByTestId("roadmap-scope")).toHaveText("All roadmaps");
        await quickAdd(page, phone, "Partner badges", "Later", "Add", "Onboarding roadmap");
        await expect(toastWith(page, "Added Partner badges as a draft")).toBeVisible();
        await expect(boardCard(page, "partner-badges")).toHaveCount(1);

        await page.getByTestId("key-dates-open").click();
        await expect(kdRow(group(page, "Alerts roadmap"), "Customer conference")).toBeVisible();
        await expect(kdRow(group(page, "Onboarding roadmap"), "Board meeting")).toBeVisible();
        await editor(page).getByLabel("New key date's name").fill("Partner summit");
        await editor(page).getByLabel("New key date's day").fill("2026-12-02");
        await expect(editor(page).getByRole("button", { name: "Add", exact: true })).toBeDisabled();
        await editor(page).getByTestId("key-date-add-roadmap").selectOption({ label: "Alerts roadmap" });
        await editor(page).getByRole("button", { name: "Add", exact: true }).click();
        await expect(toastWith(page, "Added the key date 'Partner summit' in your working draft")).toBeVisible();
        await expect(kdRow(group(page, "Alerts roadmap"), "Partner summit")).toBeVisible();
        await expect(kdRow(group(page, "Onboarding roadmap"), "Partner summit")).toHaveCount(0);
        await page.keyboard.press("Escape");

        await pick(page, "Onboarding roadmap");
        await expect(boardCard(page, "partner-badges")).toHaveCount(1);
        await pick(page, "Alerts roadmap");
        await expect(boardCard(page, "partner-badges")).toHaveCount(0);
      });

      /**
       * Card roadmap-filter-roles: protects = the filter offers only the roadmaps the person
       * may read (no approvers-only roadmap for a commenter or a viewer); a commenter's quick
       * add on the chosen roadmap is a proposal; a viewer filters and reads, with no quick
       * add; fails_when = a hidden roadmap is offered, a commenter's add applies, or a
       * viewer can add; no_claim = who decides the proposal (simple-additions.spec.ts).
       */
      test("a commenter proposes to the chosen roadmap; a viewer filters and reads", async ({ page }) => {
        await login(page, COMMENTER);
        await openBoard(page);
        await expect(page.getByTestId("filter-roadmap").locator("option")).toHaveText(["All roadmaps", "Alerts roadmap", "Onboarding roadmap"]);
        await pick(page, "Alerts roadmap");
        await quickAdd(page, phone, "Alert snooze", "Next", "Propose");
        await expect(toastWith(page, /Proposed Alert snooze/)).toBeVisible();
        await page.goto("/home");
        if (phone) {
          await page.getByTestId("phone-user-menu").click();
          await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
          await expect(page).toHaveURL(/\/login/);
        } else await signOut(page);
        await login(page, VIEWER);
        await openBoard(page);
        await expect(page.getByTestId("filter-roadmap").locator("option")).toHaveText(["All roadmaps", "Alerts roadmap", "Onboarding roadmap"]);
        await pick(page, "Onboarding roadmap");
        await expect(boardCard(page, "alert-rules")).toHaveCount(0);
        await expect(boardCard(page, "setup-checklist")).toHaveCount(1);
        await expect(page.getByTestId("quick-add")).toHaveCount(0);
        await expect(page.getByTestId("quick-add-open")).toHaveCount(0);
      });
    });
  }
}
