import { expect, test, type Page } from "./test";

import { login, openSection, section, sectionStrip } from "./helpers";

// QA pass 4, docs lane: the version page /documents/<doc>/v/<n> (Checkout redesign v2 with a
// held rewrite, Team workspaces v2 with a changed approved section, Saved carts v2 with a
// brief, Clinic outreach v5), driven as a person on the mock.

const CHECKOUT = "/documents/checkout-redesign/v/2";
const WORKSPACES = "/documents/team-workspaces/v/2";
const CARTS = "/documents/saved-carts/v/2";
const OUTREACH = "/documents/clinic-outreach/v/5";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const panel = (page: Page) => page.getByTestId("review-panel").filter({ visible: true });

async function openVersion(page: Page, url: string) {
  await login(page);
  await page.goto(url);
  await expect(page.getByTestId("document-sections")).toBeVisible();
}

async function openHeld(page: Page) {
  await page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).click();
  const held = page.getByTestId("held-rewrites").filter({ visible: true });
  await expect(held).toBeVisible();
  return held;
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-docs-7: Held rewrites says the sections were approved in an earlier version", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    const held = await openHeld(page);
    await expect(held.getByTestId("held-intro")).toContainText("after they were approved in an earlier version");
    await expect(held).not.toContainText("rewrote these approved sections");
  });

  test("qa4-docs-22: a held rewrite names its section by its heading only, with no anchor", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    const held = await openHeld(page);
    const item = held.getByTestId("held-rewrite");
    await expect(item).toContainText("1. Goal trace");
    await expect(item).not.toContainText("#goal-trace");
  });

  test("qa4-docs-33: Escape closes the Held rewrites panel", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    await openHeld(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("held-rewrites").filter({ visible: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true })).toHaveAttribute("aria-expanded", "false");
  });

  test("qa4-docs-33: Escape closes the Discuss form, as Cancel does", async ({ page }) => {
    await openVersion(page, CARTS);
    await page.getByTestId("doc-discuss").click();
    const form = page.getByTestId("start-discussion").filter({ visible: true });
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
  });

  test("qa4-docs-21: the changed-sections banner names the section by its heading, not its key", async ({ page }) => {
    await openVersion(page, WORKSPACES);
    const banner = page.locator('[data-warning="locked_section_changed"]').filter({ visible: true });
    await expect(banner).toContainText("Sections approved in v1 changed in this version:");
    await expect(banner.getByRole("link", { name: "3. Scope" })).toBeVisible();
    await expect(banner).not.toContainText(": scope");
  });

  test("qa4-docs-31: the Export menu says Markdown, not a bare MD", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    await page.getByTestId("version-toolbar").getByRole("button", { name: "Export" }).click();
    const full = page.getByRole("group", { name: "Export full" });
    await expect(full.getByRole("button", { name: "Export Markdown (.md)" })).toHaveText("Markdown (.md)");
    await expect(full.getByRole("button", { name: "MD", exact: true })).toHaveCount(0);
  });

  test("qa4-docs-32: the note's send button says Send request, so there is one Request changes", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    const goal = await openSection(page, "goal-trace");
    const bar = goal.getByTestId("review-bar");
    await bar.getByRole("group", { name: /^Verdict for/ }).getByRole("button", { name: "Request changes" }).click();
    await expect(bar.getByTestId("verdict-submit")).toHaveText("Send request");
    await expect(bar.getByRole("button", { name: "Request changes", exact: true })).toHaveCount(1);
    await bar.getByLabel(/What should change/).fill("Name the goal this serves.");
    await bar.getByTestId("verdict-submit").click();
    await expect(bar.getByTestId("verdict-state")).toContainText("Changes requested");
  });

  test("qa4-docs-35: review progress reads the same in Brief, Full and without a brief, on one card row", async ({ page }) => {
    await openVersion(page, CARTS);
    const progress = sectionStrip(page).getByTestId("review-progress");
    const stat = panel(page).getByTestId("stat-reviewed");
    await expect(progress).toHaveText(/^\d+ of 8 sections reviewed$/);
    await expect(stat.locator("dt")).toHaveText("Reviewed");
    const sameRow = async () => {
      const a = (await stat.boundingBox())!;
      const b = (await panel(page).getByTestId("stat-open-feedback").boundingBox())!;
      return Math.abs(a.y - b.y) < 2;
    };
    expect(await sameRow()).toBe(true);

    await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
    await expect(progress).toHaveText(/^\d+ of 20 sections reviewed$/);
    await expect(stat.locator("dt")).toHaveText("Reviewed");
    expect(await sameRow()).toBe(true);

    await page.goto(CHECKOUT);
    await expect(sectionStrip(page).getByTestId("review-progress")).toHaveText(/^\d+ of 11 sections reviewed$/);
  });

  test("qa4-docs-36: with the outline hidden, the progress says N of M reviewed in words", async ({ page }) => {
    await openVersion(page, OUTREACH);
    await page.getByTestId("outline-collapse").click();
    const progress = page.getByTestId("section-switcher").getByTestId("review-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toHaveText(/^\d+ of \d+ reviewed$/);
    await expect(progress).not.toContainText("/");
  });

  test("qa4-docs-58: the brief Summary names the goal in words, with no goal code", async ({ page }) => {
    await openVersion(page, CARTS);
    const summary = section(page, "summary").first();
    await expect(summary).toContainText("It serves the retention goal.");
    await expect(summary).not.toContainText("G2");
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-docs-37: the bottom bar names the open section's place in words, apart from the reviewed count", async ({ page }) => {
    await openVersion(page, CHECKOUT);
    const sections = page.getByTestId("phone-sections");
    await expect(sections).toHaveText(/^Section \d+ of 11$/);
    await expect(sections).not.toContainText("/");
    await sections.click();
    const sheet = page.getByRole("dialog", { name: "Sections" });
    await expect(sheet.getByTestId("review-progress")).toHaveText(/^\d+ of 11 sections reviewed$/);
  });
});
