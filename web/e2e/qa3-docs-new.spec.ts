import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA pass 3, docs and onboarding lanes: New PRD and New roadmap (/documents/new), driven
 * through the UI as a person would. The onboarding findings walk the mock's "empty" scenario
 * (a new company) as the owner, from Home.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** A new company: the "empty" scenario, its mock data reset. */
async function emptyCompany(page: Page) {
  await page.goto("/icon.svg");
  await page.evaluate(() => {
    localStorage.removeItem("po-mock-db-v2");
    localStorage.setItem("po-mock-scenario", "empty");
  });
}

/** Signs in as `role` (the mock's owner by default) and opens `url`. */
async function open(page: Page, url: string, role?: "viewer" | "commenter") {
  if (role) await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  await login(page);
  await page.goto(url);
}

/** Home > New PRD, as the owner of a new company. */
async function newPrdFromHome(page: Page) {
  await emptyCompany(page);
  await login(page);
  await page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeAttached();
}

const title = (page: Page) => page.getByRole("textbox", { name: "Title" });
const leave = (page: Page) => page.getByRole("dialog", { name: "Discard your changes?" });

for (const [name, viewport, home] of [
  ["desktop", DESKTOP, "nav-home"],
  ["phone", PHONE, "tab-home"],
] as const) {
  test(`qa-onboarding-1 / qa-onboarding-42 (${name}): typed words on New PRD ask before the nav leaves them`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await newPrdFromHome(page);
    await title(page).fill("Saved addresses at checkout");
    await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype");

    // Home in the rail (the tab bar on a phone): it asks first.
    await page.getByTestId(home).filter({ visible: true }).click();
    await expect(leave(page)).toBeVisible();
    await expect(leave(page)).toContainText("not saved");
    await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);

    // Keep editing keeps every word.
    await leave(page).getByRole("button", { name: "Keep editing" }).click();
    await expect(leave(page)).toHaveCount(0);
    await expect(title(page)).toHaveValue("Saved addresses at checkout");
    await expect(page).toHaveURL(/\/documents\/new\?kind=prd$/);

    // Discard leaves, and the words are gone when New PRD opens again.
    await page.getByTestId(home).filter({ visible: true }).click();
    await leave(page).getByRole("button", { name: "Discard" }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.getByRole("link", { name: "New PRD" }).filter({ visible: true }).first().click();
    await expect(title(page)).toHaveValue("");

    // Nothing typed: Home leaves at once.
    await page.getByTestId(home).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/home$/);
  });
}

test("qa-onboarding-1: a reload asks the browser's question; a draft that went through leaves without asking", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await newPrdFromHome(page);
  await title(page).fill("Saved addresses at checkout");

  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.type());
    void d.dismiss();
  });
  // Dismissed: the page stays, with its words.
  await page.reload({ timeout: 3_000 }).catch(() => {});
  await expect.poll(() => asked).toContain("beforeunload");
  await expect(title(page)).toHaveValue("Saved addresses at checkout");

  // Continue goes on to Before drafting and nothing asks.
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their address at every checkout.");
  await page.getByRole("button", { name: "Continue" }).first().click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await expect(leave(page)).toHaveCount(0);
});

test("qa-onboarding-28: New PRD's form ends with a Continue too", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await newPrdFromHome(page);
  const end = page.getByTestId("new-prd-continue-end");
  await expect(end).toHaveText("Continue");
  // Below the last section of the form (Template and Theme).
  const theme = await page.getByRole("heading", { name: "Theme" }).boundingBox();
  const endBox = await end.boundingBox();
  expect(endBox!.y).toBeGreaterThan(theme!.y);
  // It is the form's Continue: early, it says what is missing.
  await end.click();
  await expect(page.getByTestId("new-prd-missing")).toHaveText("To continue, give it a title and say what problem it solves.");
  await expect(title(page)).toBeFocused();
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-onboarding-32 (${scheme}): the Theme picker's previews are dimmed in dark mode, not bright white boxes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(DESKTOP);
    await newPrdFromHome(page);
    const frame = page.getByTestId("theme-option-clean-document").getByTestId("theme-preview-frame");
    await expect(frame).toBeVisible();
    const filter = await frame.evaluate((el) => getComputedStyle(el).filter);
    if (scheme === "dark") expect(filter).toMatch(/brightness\(0\.\d+\)/);
    else expect(filter).toBe("none");
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-docs-36: with nothing answered the recommendation says it is the usual start; no bare version; plain description", async ({ page }) => {
    await open(page, "/documents/new?kind=prd");
    const panel = page.getByTestId("recommendation-panel");
    const why = panel.getByTestId("recommendation");
    await expect(why).toContainText("The usual start, until you answer the questions");
    await expect(why).not.toContainText("Fits your answers");
    // The Selected rows name the template, with no unexplained "v1".
    await expect(panel).toContainText("Goal-traced PRD");
    await expect(panel).not.toContainText(/\bv\d+\b/);
    const description = page.getByTestId("template-option-oracle-default").getByTestId("template-description");
    await expect(description).toHaveText(
      "Oracle's standard: the goal it serves, the problem, the solution in priority order, numbered requirements, the launch and a look back",
    );

    // An answer: now it fits the answers.
    await page.getByRole("group", { name: "Who reads and approves it?" }).getByText("Product and engineering").click();
    await expect(why).toContainText("Fits your answers");
  });

  test("qa-docs-37: New roadmap's Create draft is the filled primary button, pressable before a title, saying what is missing", async ({ page }) => {
    await open(page, "/documents/new?kind=roadmap");
    const create = page.getByRole("button", { name: "Create draft" });
    await expect(create).toBeEnabled();
    await expect(create).toHaveAttribute("data-variant", "primary");
    // Filled with the accent, as New PRD's Continue.
    const fill = await create.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.goto("/documents/new?kind=prd");
    const cont = await page.getByRole("button", { name: "Continue" }).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).toBe(cont);

    await page.goto("/documents/new?kind=roadmap");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(page.getByText("Give the roadmap a title.")).toBeVisible();
    await expect(title(page)).toBeFocused();
    await expect(page).toHaveURL(/\/documents\/new\?kind=roadmap$/);
  });

  test("qa-docs-38: New roadmap's template descriptions are plain words", async ({ page }) => {
    await open(page, "/documents/new?kind=roadmap");
    const descriptions = page.getByTestId("template-description");
    await expect(descriptions).toHaveCount(5);
    const all = (await descriptions.allInnerTexts()).join("\n");
    for (const jargon of ["Rows =", "columns = horizons", "fuzzy bars", "appetite", "hill position", "cool-down", "estimate drift", "confidence horizon"]) {
      expect(all).not.toContain(jargon);
    }
    await expect(page.getByTestId("template-option-outcome-roadmap").getByTestId("template-description")).toHaveText(
      "One row per confirmed goal, with what it gets now, next and later. Shows the work that serves no goal.",
    );
    await expect(page.getByTestId("template-option-quarterly-timeline").getByTestId("template-description")).toHaveText(
      "Work laid out by quarter, one lane per team. Firm dates this quarter, rough ranges after it.",
    );
  });

  test("qa-docs-39: New roadmap names its one theme and shows the confirmed goals read-only", async ({ page }) => {
    await open(page, "/documents/new?kind=roadmap");
    await expect(page.getByTestId("theme-only")).toHaveText("Roadmap board");
    await expect(page.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Roadmap board" })).toHaveCount(0);
    await expect(page.getByTestId("confirmed-goals-count")).toHaveText("2");
    await expect(page.getByRole("spinbutton", { name: /Confirmed goals/ })).toHaveCount(0);
    await expect(page.getByTestId("confirmed-goals").getByRole("textbox")).toHaveCount(0);
  });

  test("qa-docs-35: a viewer's New PRD is an empty state with a title, a reason and one way back", async ({ page }) => {
    await open(page, "/documents/new?kind=prd", "viewer");
    const state = page.getByTestId("new-prd-not-allowed");
    await expect(state.getByRole("heading", { name: "You can't start a PRD" })).toBeVisible();
    await expect(state).toContainText("Only commenters, approvers and owners can start a PRD.");
    await expect(page.getByRole("link", { name: "Back to PRDs" })).toHaveCount(0);
    await expect(page.locator("main").getByRole("link", { name: /PRDs/ }).filter({ visible: true })).toHaveCount(1);
    await page.locator("[data-page-back]").getByRole("link", { name: "PRDs" }).click();
    await expect(page).toHaveURL(/\/documents$/);
  });

  test("qa-docs-35: a commenter's New roadmap is the same empty state", async ({ page }) => {
    await open(page, "/documents/new?kind=roadmap", "commenter");
    const state = page.getByTestId("new-draft-not-allowed");
    await expect(state.getByRole("heading", { name: "You can't start a roadmap" })).toBeVisible();
    await expect(state).toContainText("Only approvers and owners can start a roadmap.");
    await expect(state.getByRole("link")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  /** The element's box lies wholly between the phone header and the tab bar. */
  async function clearOfBars(page: Page, selector: ReturnType<Page["locator"]>) {
    const box = (await selector.boundingBox())!;
    const header = (await page.getByTestId("phone-header").boundingBox())!;
    const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(tabs.y + 0.5);
  }

  test("qa-docs-40: New PRD's top field sits clear of the phone header and the tab bar, also when Continue jumps back to it", async ({ page }) => {
    await open(page, "/documents/new?kind=prd");
    await expect(title(page)).toBeVisible();
    await clearOfBars(page, title(page));

    // From the end of the form, Continue on an empty form takes the person back to the title.
    await page.getByTestId("new-prd-continue-end").click();
    await expect(title(page)).toBeFocused();
    await clearOfBars(page, title(page));
  });

  test("qa-docs-8: New PRD's last field, scrolled to the end, is above the tab bar", async ({ page }) => {
    await open(page, "/documents/new?kind=prd");
    await expect(page.getByTestId("recommendation-panel")).toBeVisible();
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 30_000);
    const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
    // The page's last control (the recommendation sits below the form on a phone).
    const lastControl = page.locator("main").locator("input:not([type=hidden]), button, textarea").last();
    await expect(lastControl).toBeInViewport();
    const box = (await lastControl.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(tabs.y + 0.5);
    // The form's own end: its Continue, brought into view, clears both bars.
    const end = page.getByTestId("new-prd-continue-end");
    await end.scrollIntoViewIfNeeded();
    await clearOfBars(page, end);
  });

  test("qa-docs-8: New roadmap's last question, scrolled to the end, is above the tab bar", async ({ page }) => {
    await open(page, "/documents/new?kind=roadmap");
    await expect(page.getByTestId("confirmed-goals-count")).toHaveText("2");
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 30_000);
    const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
    // The page's last control (below the inspector on a phone) and the last question.
    const controls = page.locator("main").locator("input:not([type=hidden]), button, textarea");
    const lastControl = controls.last();
    await expect(lastControl).toBeInViewport();
    const box = (await lastControl.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(tabs.y + 0.5);
    const teams = page.getByRole("spinbutton", { name: "How many teams?" });
    await teams.scrollIntoViewIfNeeded();
    await clearOfBars(page, teams);
  });
});
