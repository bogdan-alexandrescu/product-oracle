import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 3, docs lane (fix4-docs-share): the tech brief page and a spec's design page
 * /specs/<id>/design/<versionId>, on the mock API's seeded spec: Checkout redesign PRD →
 * "Early shipping cost: technical brief" (v1 potentially stale, v2 the latest) → its user flow
 * and wireframes. Driven through the UI as a person would.
 */

const BRIEF_V1 = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";
const BRIEF_V2 = "/documents/checkout-redesign-early-shipping-cost-spec/v/2";
const SPEC_ID = "c3000000-0000-4000-8000-000000000001";
const FLOW = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000012`;
const WIRE = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000013`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Design review" }).filter({ visible: true });
const frame = (page: Page) => page.frameLocator('[data-testid="design-canvas"] iframe').first();

async function openDesign(page: Page, url: string, email?: string) {
  await login(page, email);
  await page.goto(url);
  await expect(visible(page, "design-canvas")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-docs-18: the tech brief's stale reasons name the section and the PRD in words", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto(BRIEF_V1);
    const reasons = visible(page, "spec-staleness").getByTestId("spec-staleness-reasons");
    await expect(reasons).toHaveText('Section "5.2 Shipping step" changed in Checkout redesign PRD');
    await expect(visible(page, "spec-staleness")).not.toContainText("s-5-2");
    await expect(visible(page, "spec-staleness")).not.toContainText("checkout-redesign");
  });

  test("qa-docs-19: a wireframe's annotation reads '1. <note>', numbered once, no ids or keys", async ({ page }) => {
    await openDesign(page, WIRE, "approver@example.com");
    const notes = frame(page).locator(".oracle-annotations");
    await expect(notes.locator("li").first()).toHaveText("1. The quote shows before the address step.");
    await expect(notes.locator("ol")).toHaveCSS("list-style-type", "none");
    await expect(notes).not.toContainText("cost-early");
    await expect(notes).not.toContainText("[s-5-2]");
  });

  test("qa-docs-80: Request changes with no note says so in plain words", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const panel = inspector(page);
    await panel.getByRole("button", { name: "Request changes" }).click();
    await expect(panel.getByRole("alert")).toHaveText("Add a note to request changes or reject.");
    await expect(panel).not.toContainText("say why:");
  });

  test("qa-docs-79: no prompts, fingerprints, sizes or sandbox jargon on the design page", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const panel = inspector(page);
    const meta = panel.getByTestId("version-meta");
    await expect(meta).toContainText("Oracle · See how it was made");
    await expect(meta.getByRole("link", { name: "See how it was made" })).toHaveAttribute("href", /^\/runs\//);
    await expect(meta).not.toContainText("in a run");
    await expect(meta).not.toContainText("Technical details");
    await expect(meta).not.toContainText("prd_to_spec");
    const file = page.getByTestId("file-details").filter({ visible: true }).first();
    await file.getByText("Details").click();
    await expect(file).toContainText("Drawing (SVG)");
    await expect(file).not.toContainText("Fingerprint");
    await expect(file).not.toContainText("Size");
    await expect(page.locator("main")).not.toContainText("sandboxed");
    await expect(page.locator("main")).toContainText("A preview: its links and buttons do nothing.");
  });

  test("qa-docs-81: the version tab strip has no stray scroll control", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const tabs = visible(page, "design-tabs");
    await expect(tabs).toHaveCSS("overflow-y", "hidden");
    const fits = await tabs.evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
    // The current tab is still underlined in the accent.
    await expect(tabs.locator('[aria-current="page"]')).toHaveCSS("border-bottom-width", "2px");
  });

  test("qa-docs-83: one named way to the tech brief; the annotations heading keeps one line", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const stale = visible(page, "stale-notice");
    await expect(stale.getByRole("link", { name: "Open the tech brief" })).toHaveAttribute("href", BRIEF_V1);
    await expect(page.getByRole("link", { name: "Review on tech brief" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Go to the tech brief" })).toHaveCount(0);
    const heading = inspector(page).getByTestId("annotations-heading");
    await expect(heading).toHaveText("Annotations · Checkout with an early quote");
    expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(20);
    // The filter chips sit below the heading.
    const chip = inspector(page).getByTestId("annotations").getByRole("button", { name: "All 2" });
    expect((await chip.boundingBox())!.y).toBeGreaterThan((await heading.boundingBox())!.y + 10);
  });

  test("qa-docs-84: a commenter's stale notice is worded for them, with no brief button", async ({ page }) => {
    await openDesign(page, FLOW, "commenter@example.com");
    const stale = visible(page, "stale-notice");
    await expect(stale).toContainText("The spec's engineering approvers review it on the tech brief before it can be approved.");
    await expect(stale).not.toContainText("before approving");
    await expect(stale.getByRole("link")).toHaveCount(0);
    await expect(inspector(page)).toContainText("Verdicts are for the spec's engineering approvers.");
  });

  test("qa-docs-78: Approve on an earlier version says what it approves", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto(BRIEF_V1);
    await expect(page.getByText("You are viewing an earlier version.")).toBeVisible();
    await expect(visible(page, "earlier-approve-note")).toHaveText("Approving here approves v1, not v2.");
    await page.goto(BRIEF_V2);
    await expect(page.getByTestId("approve-version").filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("earlier-approve-note")).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-82: the flow drawing suits the ${scheme} theme, labels in a sans-serif`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: scheme });
    await openDesign(page, FLOW, "approver@example.com");
    const body = frame(page).locator("body");
    await expect(frame(page).locator("svg")).toBeVisible();
    const bg = await body.evaluate((el) => getComputedStyle(el).backgroundColor);
    if (scheme === "dark") expect(bg).not.toBe("rgb(255, 255, 255)");
    else expect(bg).toBe("rgb(255, 255, 255)");
    const font = await frame(page).locator("svg text").first().evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).toMatch(/system-ui|sans-serif/);
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("qa-docs-9: on v1 of the tech brief, a section's verdict bar scrolled into view clears the bottom bars", async ({ page }) => {
    await login(page, "approver@example.com");
    // Reached from the latest version, as a reader does (the version left stays mounted, hidden).
    await page.goto(BRIEF_V2);
    await expect(visible(page, "phone-bar")).toBeVisible();
    await visible(page, "version-toolbar").getByRole("link", { name: "v1", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${BRIEF_V1}$`));
    await expect(page.getByText("You are viewing an earlier version.").filter({ visible: true })).toBeVisible();
    const bar = visible(page, "review-bar").first();
    const phoneBar = visible(page, "phone-bar");
    await expect(bar.getByRole("button", { name: "Request changes" })).toBeVisible();
    await expect
      .poll(async () => {
        await bar.evaluate((el) => el.scrollIntoView({ block: "end" }));
        const b = (await bar.boundingBox())!;
        const p = (await phoneBar.boundingBox())!;
        return Math.round(p.y - (b.y + b.height));
      })
      .toBeGreaterThanOrEqual(-1);
    // Scrolled to the page's end, the last section's verdict buttons are on screen, above the
    // phone bar and the bottom nav.
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 3000);
    const nav = page.getByRole("navigation", { name: "Oracle" }).filter({ visible: true }).last();
    const last = visible(page, "review-bar").last();
    for (const name of ["Approve", "Request changes", "Reject"]) {
      const b = (await last.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(0);
      const p = (await phoneBar.boundingBox())!;
      const n = (await nav.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(Math.min(p.y, n.y) + 1);
    }
    // Opening a verdict's note brings its Save clear of the bars too (without the fix it opens
    // under them).
    await bar.getByRole("button", { name: "Request changes" }).click();
    const save = bar.getByTestId("verdict-submit");
    await expect(save).toBeVisible();
    await expect
      .poll(async () => {
        const s = (await save.boundingBox())!;
        const p = (await phoneBar.boundingBox())!;
        return Math.round(p.y - (s.y + s.height));
      })
      .toBeGreaterThanOrEqual(-1);
  });

  test("qa-docs-78: the phone bar does not repeat the title, cut, above the full H1", async ({ page }) => {
    await login(page, "approver@example.com");
    await page.goto(BRIEF_V1);
    const h1 = page.getByTestId("doc-header").getByRole("heading", { level: 1 });
    await expect(h1).toContainText("Early shipping cost: technical brief");
    const title = page.getByTestId("phone-title");
    await expect(title).not.toHaveText("");
    await expect(title).not.toContainText("Early shipping cost");
  });

  test("qa-docs-81: the version tabs wrap on a phone, none cut mid-word", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    const tabs = visible(page, "design-tabs");
    const links = tabs.getByRole("link");
    await expect(links).toHaveCount(2);
    for (const link of await links.all()) {
      await expect(link).toBeVisible();
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await link.getAttribute("title")).toMatch(/^Early shipping cost: .+ · v\d+$/);
    }
    expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight)).toBe(true);
  });

  test("qa-docs-83: the phone's review button says what it opens", async ({ page }) => {
    await openDesign(page, FLOW, "approver@example.com");
    await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review the design" }).click();
    await expect(page.getByRole("dialog", { name: /Review · Early shipping cost: user flows/ })).toBeVisible();
  });
});
