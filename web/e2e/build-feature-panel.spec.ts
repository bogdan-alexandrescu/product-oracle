import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * build-feature-panel: Simple's one feature panel (mk-featurepanel FP1 B, FP2 A, FP3 A),
 * driven through the UI on the mock's default scenario. Weekly alert digest depends on Alert
 * rules engine (Found by Oracle) and starts before it ends; Mobile alert push has an
 * engineering estimate; Alert history export carries an Oracle link a person removed.
 * Desktop 1440x900 and phone 390x844.
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function go(page: Page, path: string, opts: { email?: string; theme?: "light" | "dark" } = {}) {
  const { theme = "light" } = opts;
  await page.context().addInitScript(
    ([key, themeKey, t]) => {
      localStorage.setItem(key, "");
      localStorage.setItem(themeKey, t);
    },
    [MOCK_SCENARIO_KEY, THEME_KEY, theme] as const,
  );
  await page.emulateMedia({ colorScheme: theme });
  await login(page, opts.email);
  await page.goto(path);
}

async function openOnRoadmap(page: Page, key: string, opts: { email?: string } = {}): Promise<Locator> {
  await go(page, "/simple/roadmap", opts);
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await openRoadmapItem(page, key);
  const panel = page.getByTestId("floating-card");
  await expect(panel).toBeVisible();
  return panel;
}

const dep = (panel: Locator, list: "depends" | "needed", title: string) => panel.getByTestId(`fp-list-${list}`).getByTestId("fp-dep").filter({ hasText: title });

test.describe("one feature panel, desktop", () => {
  test.use(DESKTOP);

  test("Roadmap's Timeline opens the 880 px panel: details beside the talk, the page dimmed; Esc and × close it", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAccessibleName("Weekly alert digest");
    const box = await panel.boundingBox();
    expect(Math.round(box!.width)).toBe(880);
    // On the right edge, 16 px in (the page's own scroll bar may sit beside it).
    expect(box!.x + box!.width).toBeGreaterThan(1440 - 40);
    await expect(page.getByTestId("feature-panel-backdrop")).toBeVisible();
    const details = panel.getByTestId("fp-details");
    for (const s of ["Dates", "Goal", "Links", "Milestone", "Details"]) await expect(details.getByRole("heading", { name: s, exact: true })).toBeVisible();
    await expect(panel.getByTestId("fp-clash-flag")).toHaveText("Dates clash");
    await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await openRoadmapItem(page, "alert-digest");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toBeHidden();
  });

  test("a delivery date set over Oracle's says so first, keeps one line with Restore, and Restore puts Oracle's date back", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    const oracle = (await panel.getByTestId("fp-delivery").innerText()).trim();
    await panel.getByRole("button", { name: "Change Delivery" }).click();
    const edit = panel.getByTestId("fp-edit");
    await expect(edit).toContainText(`Oracle suggests ${oracle}`);
    await expect(edit).toContainText("Your date replaces it; you can restore it later.");
    const input = edit.getByRole("textbox", { name: "Delivery" });
    const [mon, d] = (await input.inputValue()).split(" ");
    const typed = `${mon} ${Number(d) > 5 ? Number(d) - 3 : Number(d) + 3}`;
    await input.fill(typed);
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    const line = panel.getByTestId("fp-override");
    await expect(line).toContainText(`Oracle suggested ${oracle}; set to ${typed}`);
    await expect(line).toContainText(/ by \S/);
    await line.getByRole("button", { name: "Restore" }).click();
    await expect(line).toBeHidden();
    await expect(panel.getByTestId("fp-delivery")).toHaveText(oracle);
  });

  test("the owner is changed in place: pick a person, Save, and the panel names them", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    await panel.getByRole("button", { name: "Change Owner" }).click();
    const edit = panel.getByTestId("fp-edit");
    const pick = edit.getByRole("combobox", { name: "Owner" });
    await expect(pick.locator("option").nth(2)).toBeAttached();
    const was = await pick.inputValue();
    const options = await pick.locator("option").evaluateAll((os) => os.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? "" })));
    const next = options.find((o) => o.value && o.value !== was)!;
    await pick.selectOption(next.value);
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(panel.getByTestId("fp-owner")).toHaveText(next.label);
  });

  test("the milestone is changed in place: a name and a day, Save, and the panel shows them", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    await panel.getByRole("button", { name: "Change Milestone" }).click();
    const edit = panel.getByTestId("fp-edit");
    await edit.getByRole("textbox", { name: "Milestone name" }).fill("Beta for the pilot");
    await edit.getByRole("textbox", { name: "Milestone day" }).fill("bad day");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit.getByRole("alert")).toHaveText("Type the day as Nov 27");
    await edit.getByRole("textbox", { name: "Milestone day" }).fill("Dec 18");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(panel.getByTestId("fp-milestone")).toHaveText("Beta for the pilot · Dec 18");
  });

  test("review 2: the goal it serves is changed in place, says it is not Oracle's, and Restore puts Oracle's back", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest");
    await expect(panel.getByTestId("fp-goal")).toHaveText("Grow retention");
    await expect(panel.getByTestId("fp-measure")).toHaveText("Teams active after 90 days");
    await panel.getByRole("button", { name: "Change Goal" }).click();
    let edit = panel.getByTestId("fp-edit");
    await edit.getByRole("combobox", { name: "Goal" }).selectOption({ label: "Faster activation" });
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByTestId("fp-goal")).toHaveText("Grow retention");
    await panel.getByRole("button", { name: "Change Goal" }).click();
    edit = panel.getByTestId("fp-edit");
    await edit.getByRole("combobox", { name: "Goal" }).selectOption({ label: "Faster activation" });
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(panel.getByTestId("fp-goal")).toHaveText("Faster activation");
    await expect(panel.getByTestId("fp-goal-override")).toContainText(/^Oracle suggested Grow retention; set to Faster activation by \S/);
    await panel.getByRole("button", { name: "Change Measure" }).click();
    await panel.getByRole("textbox", { name: "Measure" }).fill("Teams that read a digest each week");
    await panel.getByTestId("fp-edit").getByRole("button", { name: "Save" }).click();
    await expect(panel.getByTestId("fp-measure")).toHaveText("Teams that read a digest each week");
    await panel.getByTestId("fp-goal-override").getByRole("button", { name: "Restore" }).click();
    await expect(panel.getByTestId("fp-goal")).toHaveText("Grow retention");
    await expect(panel.getByTestId("fp-goal-override")).toHaveCount(0);
    await expect(panel.getByTestId("fp-measure")).toHaveText("Teams active after 90 days");
  });

  test("review 2: a milestone the date engine wrote, with no name, is renamed in place", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    const shown = panel.getByTestId("fp-milestone");
    await expect(shown).toHaveText(/^Milestone · [A-Z][a-z]{2} \d{1,2}/);
    const dayText = (await shown.innerText()).split(" · ")[1];
    await panel.getByRole("button", { name: "Change Milestone" }).click();
    const edit = panel.getByTestId("fp-edit");
    await edit.getByRole("textbox", { name: "Milestone name" }).fill("Pilot");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(shown).toHaveText(`Pilot · ${dayText}`);
    await expect(page.getByText("Changed since you saw it")).toHaveCount(0);
  });

  test("review 2: picking its track's owner when the owner is its track's already records no change", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    const owner = await panel.getByTestId("fp-owner").innerText();
    await panel.getByRole("button", { name: "Change Owner" }).click();
    const edit = panel.getByTestId("fp-edit");
    await edit.getByRole("combobox", { name: "Owner" }).selectOption({ label: "Its track's owner" });
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(panel.getByTestId("fp-owner")).toHaveText(owner);
    await expect(page.getByText(/back to its track's owner|No change/)).toHaveCount(0);
  });

  test("Cancel leaves a field as it was", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-mobile");
    const before = await panel.getByTestId("fp-delivery").innerText();
    await panel.getByRole("button", { name: "Change Delivery" }).click();
    await panel.getByRole("textbox", { name: "Delivery" }).fill("Feb 2");
    await panel.getByTestId("fp-edit").getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByTestId("fp-delivery")).toHaveText(before);
    await expect(panel.getByTestId("fp-override")).toHaveCount(0);
  });

  test("a link that clashes shows the box naming every late link, and Move the dependents fixes it", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest");
    const depends = panel.getByTestId("fp-list-depends");
    await expect(depends.getByRole("heading")).toContainText("(1)");
    await depends.getByRole("button", { name: "+ Add an item it depends on" }).click();
    const search = panel.getByTestId("fp-search");
    await search.getByRole("textbox", { name: "Find an item" }).fill("Alert");
    await expect(search).toContainText("Already linked");
    await search.getByRole("button", { name: /Mobile alert push/ }).click();
    await expect(depends.getByRole("heading")).toContainText("(2)");
    await expect(dep(panel, "depends", "Mobile alert push")).toContainText("Added by");
    const clash = panel.getByTestId("fp-clash");
    await expect(clash).toContainText("Mobile alert push");
    await expect(clash.getByRole("button", { name: "Remove the new link" })).toBeVisible();
    await clash.getByRole("button", { name: /^Move the dependents: / }).click();
    // No link is late now (the item still runs past its milestone, which the box keeps saying).
    await expect(clash).not.toContainText("before Alert rules engine ends");
    await expect(clash).not.toContainText("before Mobile alert push ends");
    await expect(panel.getByText("Ends after this starts")).toHaveCount(0);
    await expect(panel.getByTestId("fp-override")).toContainText("Oracle suggested");
  });

  test("a link that would make a loop is shown, not offered", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-rules");
    await panel.getByTestId("fp-list-depends").getByRole("button", { name: "+ Add an item it depends on" }).click();
    const search = panel.getByTestId("fp-search");
    await search.getByRole("textbox", { name: "Find an item" }).fill("Weekly");
    await expect(search).toContainText("Needs this one: it would make a loop");
    await expect(search.getByRole("button", { name: /Weekly alert digest/ })).toBeDisabled();
  });

  test("an Oracle link a person removes stays struck through with Restore, and Restore puts it back", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest");
    const row = dep(panel, "depends", "Alert rules engine");
    await expect(row).toContainText("Found by Oracle");
    await row.getByRole("button", { name: "Remove Alert rules engine" }).click();
    await expect(row).toContainText("Oracle's link, removed by");
    await expect(row.locator(".line-through")).toHaveText("Alert rules engine");
    await expect(panel.getByTestId("fp-list-depends").getByRole("heading")).toContainText("(0)");
    await row.getByRole("button", { name: "Restore" }).click();
    await expect(row).toContainText("Found by Oracle");
    await expect(panel.getByTestId("fp-list-depends").getByRole("heading")).toContainText("(1)");
  });

  test("a viewer reads the panel only, with Suggest a change", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest", { email: "viewer@example.com" });
    await expect(panel.getByTestId("fp-read-only")).toContainText("You can read this feature.");
    await expect(panel.getByRole("button", { name: "Suggest a change" })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Change / })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^\+ Add/ })).toHaveCount(0);
  });

  test("Home opens the same panel from a feature's name", async ({ page }) => {
    await go(page, "/simple");
    const name = page.locator("button[data-feature]").first();
    await expect(name).toBeVisible();
    const title = (await name.innerText()).trim();
    await name.click();
    const panel = page.getByRole("dialog", { name: title });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("fp-details")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("Priorities opens the same panel from a feature's name", async ({ page }) => {
    await go(page, "/simple/priorities");
    const name = page.getByTestId("prio-title").locator("button[data-feature]").first();
    await expect(name).toBeVisible();
    const title = (await name.innerText()).trim();
    await name.click();
    const panel = page.getByRole("dialog", { name: title });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("fp-details")).toBeVisible();
  });

  test("Priorities' Goal buckets opens the same panel from a feature's name", async ({ page }) => {
    await go(page, "/simple/priorities");
    await page.getByRole("tab", { name: "Goal buckets" }).click();
    const name = page.getByTestId("bucket-features").locator("button[data-feature]").first();
    await expect(name).toBeVisible();
    const title = (await name.innerText()).trim();
    await name.click();
    const panel = page.getByRole("dialog", { name: title });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("fp-start")).toBeVisible();
  });

  /*
   * build-feature-panel review: Priorities passes the roadmap item id (not its title) to open
   * the panel, so two features with the same title would not open each other's. "New plan
   * tiers" (price-tiers, on the approvers-only pricing roadmap) ranks for a viewer with no
   * item id (simple-priorities.ts: "mine" is false); opening it finds no roadmap item the
   * viewer can read, so it toasts instead of silently doing nothing.
   */
  test("Priorities names a feature the role cannot read; opening it toasts instead of opening nothing", async ({ page }) => {
    await go(page, "/simple/priorities", { email: "viewer@example.com" });
    const row = page.locator('[data-testid="prio-row"][data-code="price-tiers"]');
    await expect(row).toBeVisible();
    await row.getByTestId("prio-title").locator("button[data-feature]").click();
    await expect(page.getByRole("status").filter({ hasText: "This feature is not on a roadmap yet, so it has no panel." })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Roadmap's Now / Next / Later opens the same panel from a feature's card", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("format-board").click();
    await page.locator('[data-testid="board-card"][data-item="alert-digest"]').click();
    const panel = page.getByTestId("floating-card");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAccessibleName("Weekly alert digest");
    await expect(panel.getByTestId("fp-start")).toBeVisible();
  });

  test("Roadmap's Waterfall opens the same panel from a feature's bar", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("format-waterfall").click();
    await page.locator('g[data-testid="bar"][data-item="alert-digest"]').click();
    const panel = page.getByTestId("floating-card");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAccessibleName("Weekly alert digest");
    await expect(panel.getByTestId("fp-start")).toBeVisible();
  });

  test("Roadmap's Gantt opens the same panel from a feature's bar", async ({ page }) => {
    await go(page, "/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.getByTestId("format-gantt").click();
    await page.locator('g[data-testid="bar"][data-item="alert-digest"]').click();
    const panel = page.getByTestId("floating-card");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAccessibleName("Weekly alert digest");
    await expect(panel.getByTestId("fp-start")).toBeVisible();
  });
});

test.describe("one feature panel, Meetings", () => {
  test.use(DESKTOP);

  test("a review's Roadmap step opens the same panel from a feature's name", async ({ page }) => {
    await go(page, "/simple/meetings");
    await page.getByRole("button", { name: /^Start review/ }).first().click();
    const sheet = page.getByRole("dialog", { name: "Start a review" });
    await sheet.getByLabel("PRD").selectOption({ label: "Guided setup" });
    await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
    await sheet.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: "2 Roadmap" }).click();
    const name = page.getByRole("region", { name: "Roadmap slice" }).locator("li[data-item] button[data-feature]").first();
    await expect(name).toBeVisible();
    const title = (await name.innerText()).trim();
    await name.click();
    const panel = page.getByRole("dialog", { name: title });
    await expect(panel.getByTestId("fp-details")).toBeVisible();
    await expect(panel.getByTestId("fp-list-depends")).toBeVisible();
  });
});

test.describe("one feature panel, Decisions and one-pagers (review 2)", () => {
  test.use(DESKTOP);

  test("Simple Decisions opens the same panel from the feature a question blocks", async ({ page }) => {
    await go(page, "/simple/decisions");
    const name = page.getByRole("button", { name: "Weekly alert digest", exact: true }).first();
    await expect(name).toBeVisible();
    await name.click();
    const panel = page.getByRole("dialog", { name: "Weekly alert digest" });
    await expect(panel.getByTestId("fp-details")).toBeVisible();
    await expect(panel.getByTestId("fp-goal")).toHaveText("Grow retention");
  });

  test("a PRD's one-pager opens the same panel from a bet of What we will build", async ({ page }) => {
    await go(page, "/simple/one-pagers/guided-setup");
    await page.getByRole("button", { name: "Open the feature A setup checklist that shows the next step" }).click();
    const panel = page.getByRole("dialog", { name: "Setup checklist" });
    await expect(panel.getByTestId("fp-details")).toBeVisible();
    await expect(panel.getByTestId("fp-list-depends")).toBeVisible();
  });
});

test.describe("one feature panel, phone", () => {
  test.use(PHONE);

  test("on a phone the panel fills the screen with Details and Talk tabs", async ({ page }) => {
    const panel = await openOnRoadmap(page, "alert-digest");
    const box = await panel.boundingBox();
    expect(Math.round(box!.width)).toBe(390);
    const tabs = panel.getByRole("tablist", { name: "The feature" });
    await expect(tabs.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tabpanel", { name: "Details" })).toContainText("Depends on");
    await tabs.getByRole("tab", { name: "Talk to Oracle" }).click();
    await expect(panel.getByRole("tabpanel", { name: "Talk to Oracle" }).getByRole("textbox", { name: "Message Oracle" })).toBeVisible();
    await tabs.getByRole("tab", { name: "Details" }).click();
    await panel.getByRole("button", { name: "Change Delivery" }).click();
    await expect(panel.getByTestId("fp-edit").getByRole("button", { name: "Save" })).toBeVisible();
  });
});
