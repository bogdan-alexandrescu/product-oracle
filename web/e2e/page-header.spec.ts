import { expect, test, type Page } from "./test";

import { CONSOLE_HELD_RUN, CONSOLE_HELD_RUN_ID } from "../lib/api/mock/runs";
import { login, openSeeded, seedConsoleHeld, seedRun } from "./helpers";

/**
 * I3 rule 3: one primary action per page, top-right, drawn as primary (filled), even while
 * it is disabled (New PRD's Create draft). The template and theme forms keep theirs under the
 * form instead (qa-settings-28; see FORM_PRIMARY).
 */
const PAGES = [
  "/documents",
  "/documents/new",
  "/documents/new?kind=roadmap",
  "/plan/documents",
  "/runs",
  "/settings/sources",
  "/settings/claude-accounts",
  "/settings/themes",
  "/settings/templates",
];

/** qa-settings-28: forms whose one primary sits under the form, not in the header. */
const FORM_PRIMARY = [
  ["/settings/themes/new", "Create theme"],
  ["/settings/themes/clean-document", "Save"],
  ["/settings/templates/new", "Create template"],
  ["/settings/templates/ai-feature", "Save as new version"],
] as const;

const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** The visible page header's buttons and links that carry a Button variant. */
async function headerButtons(page: Page) {
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  await expect(header).toHaveCount(1);
  // Wait for the header's action, which some pages draw once their data loads.
  await expect(header.locator('[data-variant="primary"]').first()).toBeVisible();
  return header.locator("[data-variant]").filter({ visible: true }).evaluateAll((els) => {
    const surface = getComputedStyle(document.body).backgroundColor;
    return els.map((el) => {
      const s = getComputedStyle(el);
      return {
        name: el.textContent?.trim() ?? "",
        variant: el.getAttribute("data-variant"),
        background: s.backgroundColor,
        border: s.borderTopWidth,
        disabled: el.matches(":disabled, [aria-disabled=true]"),
        surface,
      };
    });
  });
}

async function expectOneFilledPrimary(page: Page, path: string) {
  const buttons = await headerButtons(page);
  const primary = buttons.filter((b) => b.variant === "primary");
  expect(primary, `${path}: one primary action`).toHaveLength(1);
  const [p] = primary;
  // Filled: a fill of its own, no outline.
  expect(p.background, `${path}: ${p.name} is filled`).not.toBe(TRANSPARENT);
  expect(p.background, `${path}: ${p.name} is filled`).not.toBe(p.surface);
  // qa-docs-5: a disabled filled button takes the strong line outline, so it still reads as a button.
  if (!p.disabled) expect(p.border, `${path}: ${p.name} has no outline`).toBe("0px");
  // Nothing else in the header is filled.
  for (const b of buttons.filter((x) => x !== p)) {
    expect(["primary", "solid"], `${path}: ${b.name} is not filled`).not.toContain(b.variant);
  }
}

/** The whole page, outside any dialog: exactly one filled primary. */
async function expectOnePrimaryOnPage(page: Page, path: string) {
  const primary = page.locator('main [data-variant="primary"]').filter({ visible: true });
  await expect(primary, `${path}: one primary on the page`).toHaveCount(1);
}

for (const scheme of ["light", "dark"] as const) {
  test(`each page header has exactly one filled primary button (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expectOneFilledPrimary(page, path);
      await expectOnePrimaryOnPage(page, path);
    }
    for (const [path, name] of FORM_PRIMARY) {
      await page.goto(path);
      await expect(page.locator('main [data-variant="primary"]').filter({ visible: true }).filter({ hasText: name })).toHaveCount(1);
      await expect(page.locator("header[data-page-header]").filter({ visible: true }).locator('[data-variant="primary"]')).toHaveCount(0);
      await expectOnePrimaryOnPage(page, path);
    }
    // Members' one primary is the invite form's Send invite, its one way to invite (qa-settings).
    await page.goto("/settings/members");
    await expect(page.locator('main [data-variant="primary"]').filter({ visible: true }).filter({ hasText: "Send invite" })).toBeVisible();
    await expectOnePrimaryOnPage(page, "/settings/members");
    // Priorities' one primary is Save snapshot, beside its note in the Snapshots panel (qa-plan-39).
    await page.goto("/priorities");
    await expect(page.locator('main [data-variant="primary"]').filter({ visible: true }).filter({ hasText: "Save snapshot" })).toBeVisible();
    await expectOnePrimaryOnPage(page, "/priorities");
    // Sources is a search page: its one primary is the search form's Search. It sits under
    // Settings › Sources already, so its header has no Manage link (qa-work-53).
    await page.goto("/sources");
    await expectOnePrimaryOnPage(page, "/sources");
    await expect(page.locator("header[data-page-header]").filter({ visible: true }).getByRole("link", { name: "Manage" })).toHaveCount(0);
    // A run waiting at a checkpoint: Decide.
    await page.goto("/runs");
    await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Baseline to PRD" })).toBeVisible();
    // One way to decide (rirs-21): the decision below; the header's Decide only goes to it, so it
    // is not drawn as a second primary. The decision's Approve and continue is the page's one
    // filled primary (cld-5).
    await expect(page.getByTestId("run-go-decide")).not.toHaveAttribute("data-variant", "primary");
    await expect(page.locator("#decide").getByRole("button", { name: "Approve and continue" })).toHaveAttribute("data-variant", "primary");
    await expectOnePrimaryOnPage(page, "a run waiting at a checkpoint");
  });
}

/** The heights of the buttons in the decision row that holds `button`, by name. */
async function rowHeights(button: ReturnType<Page["locator"]>) {
  return button.locator("xpath=..").getByRole("button").evaluateAll((els) =>
    els.map((el) => ({ name: el.textContent?.trim() ?? "", height: Math.round(el.getBoundingClientRect().height) })),
  );
}

// fix3-minors review: the decision row's buttons share one height beside its filled primary, and
// when Oracle asks to confirm a console answer, Confirm is the page's one filled primary.
test("a run's decision row is one height, its primary Approve and continue", async ({ page }) => {
  await login(page);
  await page.goto("/runs");
  await page.locator('[data-testid="run-row"][data-document="team-onboarding"]').getByRole("link").click();
  const approve = page.locator("#decide").getByRole("button", { name: "Approve and continue" });
  await expect(approve).toHaveAttribute("data-variant", "primary");
  const heights = await rowHeights(approve);
  expect(heights.length).toBeGreaterThan(1);
  for (const b of heights) expect(b, `${b.name} is as tall as Approve and continue`).toEqual({ name: b.name, height: heights.find((x) => x.name === "Approve and continue")!.height });
});

test("a console answer waiting to be confirmed: Confirm is the one filled primary, the row one height", async ({ page }) => {
  await login(page);
  await openSeeded(page, seedConsoleHeld, `/runs/${CONSOLE_HELD_RUN_ID}`);
  const decision = page.getByRole("group", { name: "Decide: Roadmap items" });
  const confirm = decision.getByRole("button", { name: "Confirm approval" });
  await expect(confirm).toHaveAttribute("data-variant", "primary");
  await expect(decision.getByRole("button", { name: "Approve and continue" })).toHaveAttribute("data-variant", "secondary");
  await expectOnePrimaryOnPage(page, "a console answer waiting to be confirmed");
  const heights = await rowHeights(confirm);
  expect(heights.length).toBeGreaterThan(1);
  for (const b of heights) expect(b, `${b.name} is as tall as Confirm approval`).toEqual({ name: b.name, height: heights.find((x) => x.name === "Confirm approval")!.height });
});

// cld-7: a console Roadmap items answer waiting on Redo or Continue: Review items is the page's
// one filled primary; Continue is an outline row action beside Redo.
test("a console answer waiting on Redo or Continue: Review items is the one filled primary", async ({ page }) => {
  await login(page);
  const seed = JSON.parse(JSON.stringify(CONSOLE_HELD_RUN).replaceAll("0000000d4", "00000f7d4")) as typeof CONSOLE_HELD_RUN;
  const [cp] = seed.run.checkpoints;
  cp.console = {
    ...cp.console!,
    verdict: "NOT_YET",
    needs: "redo_or_continue",
    findings: ["Two Now items have no owner."],
    can_redo: true,
    redo_segment: "Roadmap items",
    redo_cost_usd: 6,
  };
  const id = await seedRun(page, seed);
  await page.goto(`/runs/${id}`);
  const line = page.getByTestId("items-review-line");
  await expect(line.getByRole("link", { name: "Review items" })).toHaveAttribute("data-variant", "primary");
  const decision = page.getByRole("group", { name: "Decide: Roadmap items" });
  await expect(decision.getByRole("button", { name: "Continue" })).toHaveAttribute("data-variant", "secondary");
  await expect(decision.getByRole("button", { name: /^Redo from/ })).toBeVisible();
  await expect(decision.getByRole("button", { name: "Approve and continue" })).toHaveCount(0);
  await expectOnePrimaryOnPage(page, "a console answer waiting on Redo or Continue");
});
