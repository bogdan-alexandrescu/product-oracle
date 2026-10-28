import { expect, test, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login, section, openSection } from "./helpers";

// O4b: a roadmap built from an approved PRD. The usage-alerts PRD's v1 is approved, and
// usage-alerts-roadmap v1 was built from it.

async function asRole(page: Page, role: "viewer" | "commenter" | "approver") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

/** Plan's Roadmap documents tab (c7: roadmap documents live inside Plan). */
async function openRoadmap(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await page.getByTestId("plan-tabs").filter({ visible: true }).getByRole("link", { name: "Roadmap documents" }).click();
  await expect(page).toHaveURL(/\/plan\/documents$/);
  await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
}

const approvedPrd = (page: Page) => page.getByTestId("approved-prd").filter({ hasText: "Usage alerts PRD" });
// Next keeps visited pages mounted (hidden): only the visible page's elements.
const status = (page: Page) => page.getByTestId("run-status").filter({ visible: true });
const source = (page: Page) => page.getByTestId("version-source").filter({ visible: true });

test("roadmap screen lists roadmaps with status, template and source PRD; PRDs lists only PRDs", async ({ page }) => {
  await openRoadmap(page);
  const rows = page.getByTestId("roadmap-row");
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toContainText("Usage alerts roadmap");
  await expect(row).toContainText("In review");
  await expect(row).toContainText("v1");
  await expect(row.getByTestId("roadmap-template")).toHaveText("Now / Next / Later");
  // The template by name alone in the row (the theme is in the inspector); the source PRD by name.
  await expect(row).not.toContainText("Roadmap board");
  await expect(page.getByTestId("roadmap-inspector")).toContainText("Roadmap board");
  await expect(row.getByTestId("roadmap-source")).toHaveText("Usage alerts PRD v1");
  await expect(row.getByRole("link", { name: "Usage alerts PRD v1" })).toHaveAttribute("href", "/documents/usage-alerts/v/1");

  // Approved PRDs, each with the roadmap built from it.
  await expect(page.getByTestId("approved-prd")).toHaveCount(1);
  await expect(approvedPrd(page)).toContainText("v1 approved");
  // The roadmaps it built are in its inspector, not in the Template column.
  await expect(approvedPrd(page).getByRole("link", { name: "Usage alerts roadmap" })).toHaveCount(0);
  await approvedPrd(page).locator("td").nth(2).click();
  await expect(page.getByTestId("roadmap-inspector").getByRole("link", { name: "Usage alerts roadmap" })).toBeVisible();

  // A roadmap opens in the document view.
  await row.getByRole("link", { name: "Usage alerts roadmap" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap$/);
  await expect(source(page).first()).toHaveText("From Usage alerts PRD v1");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);

  // PRDs: no roadmaps in the list.
  await page.getByTestId("nav-prds").click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("link", { name: "Usage alerts PRD", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Usage alerts roadmap" })).toHaveCount(0);
});

for (const role of ["viewer", "commenter"] as const) {
  test(`build roadmap: hidden for a ${role}`, async ({ page }) => {
    await asRole(page, role);
    await openRoadmap(page);
    await expect(approvedPrd(page)).toBeVisible();
    // #370: no role note; the page says View only.
    await expect(page.getByText("Approvers and owners start these runs.")).toHaveCount(0);
    await expect(page.getByTestId("view-only").filter({ visible: true })).toHaveText("View only");
    await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);
    await page.goto("/documents/usage-alerts/v/1");
    await openSection(page, "behaviour");
    await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);
  });
}

test("build roadmap: shown for an approver, on Plan's Roadmap documents and the PRD view", async ({ page }) => {
  await asRole(page, "approver");
  await openRoadmap(page);
  await expect(page.getByText("Approvers and owners start these runs.")).toHaveCount(0);
  await expect(approvedPrd(page).getByRole("button", { name: "Build roadmap" })).toBeVisible();
  await page.goto("/documents/usage-alerts/v/1");
  await page.getByRole("button", { name: "Build roadmap" }).click();
  await expect(page.getByRole("dialog", { name: "Build roadmap" })).toContainText("Usage alerts PRD v1");
});

// The owner follows the run through ("Check agents now" is an owner's control).
test("build roadmap: pick template and theme, see the estimate, start the run and follow it", async ({ page }) => {
  await openRoadmap(page);
  await approvedPrd(page).getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await expect(dialog).toContainText("Usage alerts PRD v1");
  await expect(dialog.getByLabel("Roadmap", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("option", { name: "Usage alerts roadmap (next version)" })).toBeAttached();

  // The recommendation is preselected; override the template, keep the theme.
  await expect(dialog.getByTestId("recommendation")).toContainText("Now / Next / Later");
  const templates = dialog.getByRole("radiogroup", { name: "Template" });
  await expect(templates.getByRole("radio", { name: /Now \/ Next \/ Later/ })).toBeChecked();
  await dialog.getByTestId("template-option-outcome-roadmap").click();
  await expect(templates.getByRole("radio", { name: /Outcome roadmap/ })).toBeChecked();
  await dialog.getByTestId("theme-option-roadmap-board").click();
  await expect(dialog.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Roadmap board" })).toBeChecked();

  // Estimate before start: per segment and the total.
  await expect(dialog.getByRole("button", { name: "Start run" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Estimate" }).click();
  const estimate = dialog.getByTestId("estimate");
  await expect(estimate).toContainText("Roadmap items");
  await expect(estimate).toContainText("Roadmap draft");
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$14.50");
  await expect(estimate).toContainText("Spending past 1.5×");

  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap from an approved PRD" })).toBeVisible();
  await expect(status(page)).toHaveText("Running");
  await expect(source(page)).toHaveText("From Usage alerts PRD v1");
  await expect(page.getByText("template outcome-roadmap, theme roadmap-board")).toBeVisible();

  // Roadmap items: the check's counts and problems, then the checkpoint.
  await page.getByRole("button", { name: "Check agents now" }).click();
  const items = page.getByTestId("segment-roadmap_items");
  await expect(items.getByTestId("items-check")).toContainText("1 roadmap item: 1 now, 0 next, 0 later");
  // D2: the item's problem reads as its blocking reason (chip, sentence naming the PRD version, fix).
  await expect(items.getByTestId("items-check")).toContainText("1 roadmap item: 1 now, 0 next, 0 later · 1 blocking");
  // D1 (#542): the run page shows the stop's summary; the item, its reason and its fix are on
  // the Roadmap items review screen, where it is decided.
  await expect(items.getByTestId("items-review-line")).toContainText("1 need you · 1 blocking");
  await expect(items.getByTestId("reason-chip")).toHaveCount(0);
  await items.getByTestId("items-review-line").getByRole("link", { name: "Review items" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Roadmap items" })).toBeVisible();
  const item = page.locator('[data-testid="roadmap-item-row"][data-key="price-early"]');
  await expect(item.getByTestId("reason-chip")).toHaveText(["No PRD section"]);
  await expect(item.getByRole("button", { name: "Link section", exact: true })).toBeVisible();
  await item.locator('[data-phone="title"]').click();
  await expect(page.getByTestId("roadmap-item-inspector").getByTestId("reason-card")).toContainText(/Section features is not in .+ v\d+\./);
  await page.getByTestId("decision-bar").getByRole("button", { name: /^Approve/ }).click();
  await expect(page.getByTestId("review-status")).toHaveText("Approved");
  await page.getByRole("link", { name: /^Roadmap from an approved PRD from / }).click();

  // Roadmap draft: imported as the roadmap's next version, linked to the PRD.
  await page.getByRole("button", { name: "Check agents now" }).click();
  const draft = page.getByTestId("segment-roadmap_draft");
  await expect(draft.getByTestId("checkpoint-roadmap_review")).toContainText("Roadmap review");
  await expect(draft).toContainText("Imported as usage-alerts-roadmap v2");
  await expect(draft.getByTestId("prd-links")).toContainText("6 links to PRD sections");
  await draft.getByRole("link", { name: "usage-alerts-roadmap v2" }).click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts-roadmap\/v\/2$/);
  await expect(source(page)).toHaveText("From Usage alerts PRD v1");
});

test("build roadmap from the PRD view, into a new roadmap", async ({ page }) => {
  await login(page);
  // Not approved: no Build roadmap.
  await page.goto("/documents/checkout-redesign/v/2");
  await expect(page.getByTestId("document-sections").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);

  await page.goto("/documents/usage-alerts/v/1");
  await page.getByRole("button", { name: "Build roadmap" }).click();
  const dialog = page.getByRole("dialog", { name: "Build roadmap" });
  await expect(dialog).toContainText("Usage alerts PRD v1");
  await dialog.getByLabel("Roadmap", { exact: true }).selectOption({ label: "New roadmap with another name…" });
  await expect(dialog.getByRole("button", { name: "Estimate" })).toBeDisabled();
  await dialog.getByLabel("New roadmap slug").fill("alerts-plan");
  await dialog.getByRole("button", { name: "Estimate" }).click();
  await expect(dialog.getByTestId("estimate-total")).toHaveText("$14.50");
  await dialog.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByText("alerts-plan (new)")).toBeVisible();
  await expect(page.getByText("template now-next-later, theme roadmap-board")).toBeVisible();
});

test("a roadmap version names its PRD, and its PRD links open the PRD view at the section", async ({ page }) => {
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await expect(source(page)).toHaveText("From Usage alerts PRD v1");
  await expect(source(page).getByRole("link")).toHaveAttribute("href", "/documents/usage-alerts/v/1");
  // A roadmap is reviewed like a PRD: brief / full, Present, exports.
  await expect(page.getByRole("group", { name: "Document view" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Build roadmap" })).toHaveCount(0);

  const link = (await openSection(page, "brief-items")).getByRole("link", { name: "1. Behaviour" });
  // One section link form everywhere (sectionHref): #key; the older #s-key still opens it.
  await expect(link).toHaveAttribute("href", "/documents/usage-alerts/v/1#behaviour");
  await expect(link).not.toHaveAttribute("target", "_blank");
  await link.click();
  await expect(page).toHaveURL(/\/documents\/usage-alerts\/v\/1#behaviour$/);
  await expect(section(page, "behaviour")).toBeVisible();

  // Present mode carries the provenance on the deck.
  await page.goto("/documents/usage-alerts-roadmap/v/1/present");
  await expect(page.getByTestId("present-mode")).toContainText("From Usage alerts PRD v1");
});

test("a roadmap date whose basis was withdrawn is marked in the version view; the text is unchanged", async ({ page }) => {
  // O4 'document dates': the mock seeds ENG-412 (verified, 2026-11-30) and ENG-413
  // (withdrawn, 2026-12-15) for the usage-alerts PRD.
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
  const item = await openSection(page, "item-behaviour");
  const body = item.locator('[data-section-body="item-behaviour"]');
  await expect(body).toContainText("Beta by 2026-11-30 (ENG-412 estimate)");
  const marks = body.locator(".date-mark");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("date withdrawn");
  await expect(marks.first()).toHaveAttribute("data-date-mark", "withdrawn");
  await expect(marks.first()).toHaveAttribute("title", /ENG-413/);
  // The marker sits right after the date it marks, outside the anchored text.
  const before = await marks.first().evaluate((el) => el.previousSibling?.textContent ?? "");
  expect(before.endsWith("2026-12-15")).toBe(true);
  await expect(marks.first()).toHaveAttribute("data-anchor-ignore", "");
});

test("a roadmap version with a marked date cannot be approved: Approve is disabled with the reason", async ({ page }) => {
  // Owner, 2026-10-20: approval waits until every date marker is resolved. The mock's v1
  // writes 2026-12-15, whose basis (ENG-413) was withdrawn.
  await login(page);
  await page.goto("/documents/usage-alerts-roadmap/v/1");
  const blocked = page.getByTestId("approve-blocked").filter({ visible: true });
  await expect(blocked.getByRole("button", { name: "Approve version" })).toBeDisabled();
  await expect(blocked).toContainText("Dec 15, 2026 (date withdrawn)");
  await expect(blocked).toContainText("Record a basis");
});
