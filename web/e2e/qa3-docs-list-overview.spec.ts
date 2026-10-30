import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 3, docs lane: the PRDs list (/documents) and a PRD's overview (/documents/<doc>),
// driven as a person, on a desktop and a phone, light and dark.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

type Role = "viewer" | "commenter" | "approver" | "owner";

async function setUp(page: Page, { role = "owner", theme }: { role?: Role; theme?: "light" | "dark" } = {}) {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, role] as const);
  if (theme) await page.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
  await login(page);
}

async function openList(page: Page, opts?: Parameters<typeof setUp>[1]) {
  await setUp(page, opts);
  await page.goto("/documents");
  await expect(page.getByTestId("document-row").first()).toBeVisible();
}

async function openDoc(page: Page, doc: string, opts?: Parameters<typeof setUp>[1]) {
  await setUp(page, opts);
  await page.goto(`/documents/${doc}`);
  await expect(page.getByTestId("versions-table")).toBeVisible();
}

const row = (page: Page, title: string) => page.getByTestId("document-row").filter({ hasText: title });
const listInspector = (page: Page) => page.getByTestId("document-inspector");
const versionInspector = (page: Page) => page.getByTestId("version-inspector");

/** Selects a list row (a click on the row already selected would open it). */
async function pick(page: Page, title: string) {
  const r = row(page, title);
  if ((await r.getAttribute("aria-selected")) !== "true") await r.locator("td").last().click({ position: { x: 4, y: 4 } });
  await expect(r).toHaveAttribute("aria-selected", "true");
}

/** Scrolls whatever scrolls under the pointer (the window or the shell's main) to its end. */
async function scrollToEnd(page: Page) {
  const { width, height } = page.viewportSize()!;
  await page.mouse.move(width / 2, height / 3);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(200);
}

/** The element's box ends above the phone's bottom tab bar. */
async function aboveTabBar(page: Page, el: Locator) {
  const bar = await page.getByTestId("tab-bar").boundingBox();
  const box = await el.boundingBox();
  expect(bar).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y);
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-docs-23: who imported a version is a person or an integration, never a credential's name", async ({ page }) => {
    for (const doc of ["saved-carts", "checkout-redesign"]) {
      await openDoc(page, doc);
      const by = versionInspector(page).getByTestId("version-importer");
      await expect(by).toHaveText("An integration");
      await expect(versionInspector(page)).not.toContainText("API token");
      await expect(versionInspector(page)).not.toContainText("agent-track");
    }
  });

  test("qa-docs-24: the overview says the PRD's status once, beside its title", async ({ page }) => {
    await openDoc(page, "saved-carts");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first();
    await expect(crumb.getByRole("link", { name: "PRDs" })).toBeVisible();
    await expect(crumb).not.toContainText("Draft");
    await expect(crumb).not.toContainText("Saved carts PRD");
    const statuses = page.locator("[data-status]").filter({ visible: true });
    await expect(statuses).toHaveCount(1);
    await expect(page.locator("[data-page-header]").locator("[data-status]")).toHaveText("Draft");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`qa-docs-25 (${theme}): Diff from v1 is drawn in the link colour`, async ({ page }) => {
      await openDoc(page, "saved-carts", { theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const link = page.getByTestId("versions-table").getByRole("link", { name: "Diff from v1" });
      await expect(link).toBeVisible();
      const [color, accent, text] = await link.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const a = getComputedStyle(probe).color;
        probe.style.color = "var(--text)";
        const t = getComputedStyle(probe).color;
        probe.remove();
        return [getComputedStyle(el).color, a, t];
      });
      expect(color).toBe(accent);
      expect(color).not.toBe(text);
    });
  }

  test("qa-docs-26: the open Ask for feedback form hides its opener; Send says why it waits", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const panel = page.getByTestId("campaigns");
    await panel.getByRole("button", { name: "Ask for feedback" }).click();
    await expect(panel.getByRole("button", { name: "Ask for feedback" })).toHaveCount(0);
    const send = panel.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription("Add a title to send");
    // The reason sits right beside Send, before Cancel.
    const sendBox = (await send.boundingBox())!;
    const hintBox = (await panel.getByTestId("campaign-send-hint").boundingBox())!;
    const cancelBox = (await panel.getByRole("button", { name: "Cancel" }).boundingBox())!;
    expect(hintBox.x).toBeGreaterThan(sendBox.x);
    expect(hintBox.x).toBeLessThan(cancelBox.x);
    await panel.getByLabel("Title").fill("Pilot read-through");
    await expect(send).toBeEnabled();
    await expect(send).not.toHaveAttribute("aria-describedby", /.+/);
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel.getByRole("button", { name: "Ask for feedback" })).toBeVisible();
  });

  test("qa-docs-27: the ⋯ menu repeats no Open latest and leaves the version card's heading clear", async ({ page }) => {
    await openDoc(page, "saved-carts");
    await expect(page.getByRole("link", { name: "Open latest (v2)" })).toBeVisible();
    await page.getByRole("button", { name: "Actions for Saved carts PRD" }).click();
    const menu = page.getByRole("menu", { name: "Actions for Saved carts PRD" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Open/ })).toHaveCount(0);
    await expect(menu.getByRole("menuitem")).toHaveText(["Regenerate…", "Delete…"]);
    const heading = versionInspector(page).getByRole("heading", { name: "v2" });
    const m = (await menu.boundingBox())!;
    const h = (await heading.boundingBox())!;
    expect(m.y + m.height).toBeLessThanOrEqual(h.y);
  });

  test("qa-docs-29: the technical brief is listed under Tech briefs, and the counts add up", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const briefs = page.getByTestId("tech-briefs");
    const specs = page.getByTestId("engineering-specs");
    await expect(briefs).toContainText("Early shipping cost: technical brief");
    await expect(specs).not.toContainText("Early shipping cost: technical brief");
    await expect(specs.getByTestId("engineering-spec")).toHaveCount(0);
    await expect(specs.getByTestId("engineering-specs-empty")).toContainText("under Tech briefs");
    // The two feature briefs and the requested technical brief, all in one card.
    await expect(briefs.getByRole("listitem")).toHaveCount(3);
  });

  test("qa-docs-30: a feedback campaign is ended with End campaign, not a bare Close", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    const campaign = page.getByTestId("campaigns").getByRole("listitem").filter({ hasText: "Company-wide feedback" });
    await expect(campaign.getByRole("button", { name: /^Close/ })).toHaveCount(0);
    const end = campaign.getByRole("button", { name: "End campaign Company-wide feedback" });
    await expect(end).toHaveText("End campaign");
    await end.click();
    await expect(campaign).toContainText("Closed");
    await expect(campaign.getByRole("button", { name: "Reopen Company-wide feedback" })).toBeVisible();
  });

  test("qa-docs-32: the list opens a PRD one way; Read latest says what it opens; the menu has no Open", async ({ page }) => {
    await openList(page);
    await pick(page, "Saved carts PRD");
    const inspector = listInspector(page);
    await expect(inspector.getByRole("link", { name: /^Open/ })).toHaveCount(1);
    await expect(inspector.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", "/documents/saved-carts");
    await expect(inspector.getByRole("link", { name: "Read latest (v2)" })).toHaveAttribute("href", "/documents/saved-carts/v/2");
    await expect(inspector.getByRole("link", { name: /^Read v\d+$/ })).toHaveCount(0);
    await row(page, "Usage alerts PRD").getByRole("button", { name: "Actions for Usage alerts PRD" }).click();
    const menu = page.getByRole("menu", { name: "Actions for Usage alerts PRD" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Open/ })).toHaveCount(0);
  });

  test("qa-docs-33: a PRD with no template or theme says so in words", async ({ page }) => {
    await openList(page);
    const alerts = row(page, "Usage alerts PRD");
    await expect(alerts.getByTestId("no-template")).toHaveText("No template");
    for (const cell of await alerts.locator("td").allInnerTexts()) expect(cell.trim()).not.toBe("–");
    await pick(page, "Usage alerts PRD");
    await expect(listInspector(page).getByTestId("inspector-template")).toHaveText("No template");
    await expect(listInspector(page).getByTestId("inspector-theme")).toHaveText("No theme");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-docs-24 (phone): the crumb leads back with no second status", async ({ page }) => {
    await openDoc(page, "saved-carts");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).filter({ visible: true }).first();
    await expect(crumb).not.toContainText("Draft");
    await expect(page.locator("[data-status]").filter({ visible: true })).toHaveCount(1);
  });

  test("qa-docs-34: the column headers draw nothing over the first row", async ({ page }) => {
    await openList(page);
    // A phone sorts from the menu above the list: no header button lies over the rows.
    await expect(page.getByTestId("sort-menu")).toBeVisible();
    for (const k of ["title", "status", "latest", "updated"]) await expect(page.getByTestId(`sort-${k}`)).toBeHidden();
    const first = page.getByTestId("document-row").first();
    for (const cell of await first.locator("td").filter({ visible: true }).all()) {
      const box = (await cell.boundingBox())!;
      if (box.width < 2 || box.height < 2) continue;
      const inRow = await first.evaluate(
        (tr, [x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && tr.contains(hit);
        },
        [box.x + box.width / 2, box.y + box.height / 2] as const,
      );
      expect(inRow).toBe(true);
    }
  });

  test("qa-docs-8: at the end of the list the last PRD's status sits above the tab bar", async ({ page }) => {
    await openList(page);
    await scrollToEnd(page);
    const last = page.getByTestId("document-row").last();
    await expect(last).toContainText("Usage alerts PRD");
    await aboveTabBar(page, last.locator("[data-status]"));
    await aboveTabBar(page, last.getByRole("link", { name: /^v\d+$/ }));
  });

  test("qa-docs-8: at the end of the overview the Feedback campaigns card sits above the tab bar", async ({ page }) => {
    await openDoc(page, "checkout-redesign");
    await expect(page.getByTestId("campaigns")).toContainText("Company-wide feedback");
    await scrollToEnd(page);
    await aboveTabBar(page, page.getByTestId("campaigns"));
  });
});
