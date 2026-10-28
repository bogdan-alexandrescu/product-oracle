import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 1, docs lane: a PRD's overview (/documents/<doc>): its header, version panel,
// section owners and engineering specs.

type Role = "viewer" | "commenter" | "approver" | "owner";

async function open(page: Page, doc: string, role: Role = "owner") {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [
    MOCK_ROLE_KEY,
    role,
  ] as const);
  await login(page);
  await page.goto(`/documents/${doc}`);
  await expect(page.getByTestId("versions-table")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("version-inspector");
const versionRow = (page: Page, n: number) =>
  page
    .getByTestId("versions-table")
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: `Version ${n}` }) });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-24: the header names the template and theme", async ({
    page,
  }) => {
    await open(page, "saved-carts");
    await expect(page.getByTestId("doc-template")).toHaveText(
      "Template: Goal-traced PRD",
    );
    await expect(page.getByTestId("doc-theme")).toHaveText(
      "Theme: Clean document",
    );
    await expect(page.getByTestId("doc-template")).not.toHaveClass(/font-mono/);
  });

  test("qa-docs-26: who imported a version, in words, and no hash", async ({
    page,
  }) => {
    await open(page, "saved-carts");
    await expect(inspector(page)).not.toContainText("Hash");
    await expect(inspector(page)).not.toContainText(/\b[0-9a-f]{8}\b/);
    const by = inspector(page).getByTestId("version-importer");
    await expect(by).toHaveText(/^(API token .+|Oracle|.+@.+|[A-Z].*)$/);
    await expect(by).not.toHaveText("agent-track");
    await expect(by).not.toHaveAttribute("title", /.+/);
    await expect(inspector(page)).toContainText("Imported by");
  });

  test("qa-docs-46, qa-docs-66: one Open for the latest; an earlier version opens by its number", async ({
    page,
  }) => {
    await open(page, "saved-carts");
    // The latest is picked: the header's Open latest is the one way in.
    await expect(
      page.getByRole("link", { name: "Open latest (v2)" }),
    ).toHaveCount(1);
    await expect(
      inspector(page).getByRole("link", { name: /^Open/ }),
    ).toHaveCount(0);
    await expect(inspector(page).getByTestId("version-approved")).toHaveText(
      "Not approved",
    );
    await expect(inspector(page)).not.toContainText(
      /Warnings\s*0|0\s*Warnings/i,
    );

    await versionRow(page, 1).locator("td").last().click();
    const earlier = inspector(page).getByRole("link", { name: "Open v1" });
    await expect(earlier).toBeVisible();
    await earlier.click();
    await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/1$/);
  });

  test("qa-docs-46, qa-docs-66: a PRD's spec opens on the spec's latest version, under its own label", async ({
    page,
  }) => {
    await open(page, "checkout-redesign");
    const spec = page
      .getByTestId("engineering-specs")
      .getByTestId("engineering-spec")
      .first();
    const link = spec.getByRole("link", {
      name: "Open Early shipping cost: technical brief",
    });
    await expect(link).toHaveText("Open spec");
    // The brief's record names v1; an edit made v2, the latest.
    await expect(link).toHaveAttribute(
      "href",
      "/documents/checkout-redesign-early-shipping-cost-spec/v/2",
    );
    await link.click();
    await expect(page).toHaveURL(
      /\/documents\/checkout-redesign-early-shipping-cost-spec\/v\/2$/,
    );
  });

  test("qa-docs-45: sections with no owner fold into one line; no title or repeated section", async ({
    page,
  }) => {
    await open(page, "saved-carts", "approver");
    const panel = page.getByTestId("section-assignments");
    const fold = panel.getByTestId("unassigned-sections");
    await expect(fold).toContainText(
      /\d+ sections?, no owner yet|\d+ more sections? with no owner/,
    );
    await expect(panel.getByText("No owner", { exact: true })).toHaveCount(0);
    await fold.getByRole("button", { name: "Assign" }).click();
    const headings = await panel
      .locator("li[data-section-key] span.font-semibold")
      .allInnerTexts();
    expect(headings.length).toBeGreaterThan(0);
    expect(headings).not.toContain("Saved carts PRD");
    expect(headings).toContain("Sources and data points");
    expect(headings).not.toContain("Sources");
    await fold.getByRole("button", { name: "Hide" }).click();
    await expect(panel.getByText("No owner", { exact: true })).toHaveCount(0);
  });

  test("qa-docs-45: a viewer sees the folded sections with Show, not Assign", async ({
    page,
  }) => {
    await open(page, "saved-carts", "viewer");
    const fold = page
      .getByTestId("section-assignments")
      .getByTestId("unassigned-sections");
    await expect(fold.getByRole("button", { name: "Assign" })).toHaveCount(0);
    await fold.getByRole("button", { name: "Show" }).click();
    await expect(
      page
        .getByTestId("section-assignments")
        .getByRole("button", { name: /^Edit owner/ }),
    ).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-24: the template and theme names wrap, nothing runs off the screen", async ({
    page,
  }) => {
    await open(page, "saved-carts");
    await expect(page.getByTestId("doc-template")).toHaveText(
      "Template: Goal-traced PRD",
    );
    await expect(page.getByTestId("doc-theme")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
  });
});
