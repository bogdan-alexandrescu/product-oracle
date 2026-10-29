import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 1, docs lane, a spec's design page /specs/<id>/design/<versionId> on the mock API.
 *
 * qa-docs-35: section headings and document titles, not section keys, slugs, ids, hashes or
 * media types; the technical record sits in closed Details.
 * qa-docs-67: Approve reads enabled when it is, and says why when it is not; "Open tech brief"
 * and the stale message each show once; no "—".
 * qa-docs-68: on a phone the full title is on the page, wrapped.
 */

const SPEC_ID = "c3000000-0000-4000-8000-000000000001";
const FLOW = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000012`;
const WIRE = `/specs/${SPEC_ID}/design/c3000000-0000-4000-8000-000000000013`;

const inspector = (page: Page) => page.getByRole("complementary", { name: "Design review" }).filter({ visible: true });

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("design-canvas").filter({ visible: true })).toBeVisible();
}

test("qa-docs-35: the design page names sections, documents and requirements in words", async ({ page }) => {
  await login(page, "approver@example.com");
  await open(page, FLOW);
  const main = page.locator("main");
  const stale = page.getByTestId("stale-notice").filter({ visible: true });
  await expect(stale).toContainText('Section "5.2 Shipping step" changed in Checkout redesign PRD');

  const panel = inspector(page);
  await expect(panel.getByTestId("annotation").first()).toContainText("5.2 Shipping step");
  await expect(panel.getByTestId("annotation").first()).toContainText("Show shipping cost on the cart");
  await expect(panel.getByTestId("version-meta")).toContainText("From PRD");
  await expect(panel.getByTestId("version-meta")).toContainText("Checkout redesign PRD v1");
  await expect(panel.getByTestId("version-meta")).toContainText("Oracle, in a run");

  // No ids, keys, slugs, hashes or media types on screen.
  for (const raw of ["s-5-2", "checkout-redesign", "req-shipping-cost", "cost-early", "c3000000", "sha256", "image/svg+xml", "prd_to_spec", "claude-code", "→"]) {
    await expect(main.getByText(raw, { exact: false }).filter({ visible: true })).toHaveCount(0);
  }

  // The technical record is one click away, in closed Details.
  const file = page.getByTestId("file-details").first();
  await expect(file).not.toHaveAttribute("open", "");
  await file.getByText("Details").click();
  await expect(file).toContainText("checkout-flow.svg");
  await expect(file).toContainText("Drawing (SVG)");
  const tech = panel.getByTestId("version-details");
  await tech.getByText("Technical details").click();
  await expect(tech).toContainText("prd_to_spec/1");
  await expect(tech).toContainText("claude-code");
});

test("qa-docs-67: one tech brief link, one stale message, Approve says why it is off, no dashes", async ({ page }) => {
  await login(page);
  await open(page, FLOW);
  await expect(page.getByRole("link", { name: "Open tech brief" })).toHaveCount(0);
  await expect(page.getByText(/Potentially stale: /).filter({ visible: true })).toHaveCount(1);
  const panel = inspector(page);
  await expect(panel.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(panel.getByTestId("approve-off")).toContainText("Approve opens once this version is reviewed or reconciled on the tech brief");
  await expect(page.locator("main")).not.toContainText("—");
  await expect(page.locator("main")).not.toContainText("–");
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-67: an enabled Approve is filled with the accent (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    await open(page, WIRE);
    const approve = inspector(page).getByRole("button", { name: "Approve" });
    await expect(approve).toBeEnabled();
    await expect(inspector(page).getByTestId("approve-off")).toHaveCount(0);
    const [bg, accent] = await approve.evaluate((el) => {
      const probe = document.createElement("span");
      probe.className = "bg-accent";
      document.body.append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(el).backgroundColor, want];
    });
    expect(bg).toBe(accent);
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-68: the full title shows on the page, wrapped", async ({ page }) => {
    await login(page, "approver@example.com");
    await open(page, FLOW);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toContainText("Early shipping cost: user flows");
    // Not the screen-reader-only 1 px heading: a real, wrapped title.
    const box = await h1.boundingBox();
    expect(box && box.height >= 20 && box.width >= 200).toBeTruthy();
    const fits = await h1.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
