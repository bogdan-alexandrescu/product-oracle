import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/**
 * Visual QA, batch B (share and publish), driven as a person would on the mock API.
 *
 * Test cards (protects / fails_when / no_claim):
 * - B-10: protects=the roadmap's Audience view preview is captioned "How the exported page looks"
 *   and framed by a line that stands out from the dark page; fails_when=no caption, or the
 *   frame's line is the faint one (or none) that melts into the dark theme; no_claim=the
 *   exported page's own content.
 * - B-23: protects=the Publish page's phone bar reads "Publish" alone, and the selected block's
 *   chips use plain words ("Selected", "Must fix"); fails_when=the bar carries the document's
 *   name ("Publish Online deposits at booking v3", cut) or the chips say "Hard check" /
 *   "Block · selected".
 * - B-20: protects=a tap on the overview's warnings chip at 390 px opens a tip with the
 *   warning's words; fails_when=the chip only has a hover title and a tap opens nothing.
 */

const PHONE = { width: 390, height: 844 };

async function openPublish(page: Page, slug: string) {
  await login(page);
  await page.goto(`/documents/${slug}/publish`);
  await expect(page.getByTestId("hard-check").first()).toBeVisible();
}

/** "#1e3350" or "rgb(30, 51, 80)" as [r, g, b]. */
function rgb(color: string): number[] {
  const c = color.trim();
  if (c.startsWith("#")) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  return (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
}

test("B-10: the Audience view preview has a caption and a frame that shows on the dark theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap");
  const view = page.getByTestId("audience-view");
  await expect(view.getByText("How the exported page looks", { exact: true })).toBeVisible();
  const preview = view.locator('iframe[title="Roadmap for Team"]');
  await expect(preview).toBeVisible();
  await expect(page.frameLocator('iframe[title="Roadmap for Team"]').locator("body")).not.toBeEmpty();

  const look = await preview.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      width: parseFloat(s.borderTopWidth),
      color: s.borderTopColor,
      background: s.backgroundColor,
      strong: getComputedStyle(document.documentElement).getPropertyValue("--line-strong"),
      faint: getComputedStyle(document.documentElement).getPropertyValue("--line"),
    };
  });
  // The export stays a white page.
  expect(rgb(look.background)).toEqual([255, 255, 255]);
  expect(look.width).toBeGreaterThanOrEqual(1);
  expect(look.color).not.toMatch(/rgba\(.*,\s*0\)$|transparent/);
  // The frame is the strong line, not the faint one that disappears on the dark page.
  expect(rgb(look.color)).toEqual(rgb(look.strong));
  expect(rgb(look.color)).not.toEqual(rgb(look.faint));
});

test("B-23: the selected block's chips use plain words", async ({ page }) => {
  await openPublish(page, "online-deposits");
  const inspector = page.getByTestId("publish-inspector");
  await expect(inspector).toContainText("Same-day refund rule unanswered");
  await expect(inspector.getByText("Selected", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Must fix", { exact: true })).toBeVisible();
  await expect(inspector).not.toContainText("Hard check");
  await expect(inspector).not.toContainText("Block · selected");

  await page.getByTestId("block-row").nth(1).click();
  await expect(inspector).toContainText("Supported third-party operations");
  await expect(inspector.getByText("Must fix", { exact: true })).toBeVisible();
  await expect(inspector).not.toContainText("Hard check");
});

test.describe("at 390 px", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("B-23: the Publish page's phone bar reads Publish alone; the crumb names the document", async ({ page }) => {
    await openPublish(page, "online-deposits");
    await expect(page.getByTestId("phone-title")).toHaveText("Publish");
    await expect(
      page.getByTestId("publish-header").getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Online deposits at booking" }),
    ).toBeVisible();
  });

  test("B-20: a tap on the overview's warnings chip opens its warnings", async ({ page }) => {
    await login(page);
    await page.goto("/documents/team-workspaces");
    const chip = page.getByTestId("versions-table").getByTestId("overview-warnings-chip").filter({ visible: true });
    await expect(chip).toHaveText("1 warning");
    const tip = page.getByRole("tooltip").filter({ visible: true });
    await expect(tip).toHaveCount(0);
    await chip.tap();
    await expect(tip).toHaveText("Sections approved in v1 changed in this version: 3. Scope");
  });
});
