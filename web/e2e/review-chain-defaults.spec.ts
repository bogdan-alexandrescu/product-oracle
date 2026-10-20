import { expect, test } from "@playwright/test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login, openSection, outlineRow } from "./helpers";

/**
 * Engineering defaults of the PRD review chain: the outline rail marks a lapsed approval
 * as the section view does, and Home lists the revokes a disable could not make, as the
 * Inbox does.
 */

const DB_KEY = "po-mock-db-v2";
const DOC = "/documents/checkout-redesign/v/1";

test("outline rail: a lapsed approval shows Lapsed, never a check, as the section view does", async ({ page }) => {
  await login(page);
  // goal-trace's approval on v1 lapses (its approver was removed).
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    const version = db.versions.find((v: { slug?: string; number: number; document_id: string }) => v.number === 1 && db.documents.find((d: { id: string; slug: string }) => d.id === v.document_id)?.slug === "checkout-redesign");
    const review = db.reviews.find((r: { version_id: string; section_key: string }) => r.version_id === version.id && r.section_key === "goal-trace");
    review.lapsed_at = "2026-10-19T09:00:00Z";
    review.lapse_reason = "former.pm@example.com was removed";
    localStorage.setItem(key, JSON.stringify(db));
  }, DB_KEY);
  await page.goto(DOC);
  const mark = outlineRow(page, "goal-trace").getByTestId("status-mark");
  await expect(mark).toHaveAttribute("data-state", "lapsed");
  await expect(mark.locator('path[d^="M4.8 8.2"]')).toHaveCount(0);
  await expect(outlineRow(page, "goal-trace")).toHaveAttribute("aria-label", /, Lapsed/);
  // The section view says the same.
  const bar = (await openSection(page, "goal-trace")).getByTestId("review-bar");
  await expect(bar.getByTestId("verdict-lapsed")).toHaveText("Lapsed");
});

test("home: owners see the revokes a disable could not make, as in the Inbox, and act on them", async ({ page }) => {
  await login(page);
  await page.goto("/home");
  const needs = page.getByTestId("home-needs-table");
  const github = needs.getByRole("row").filter({ hasText: "GitHub" });
  await expect(github).toContainText("Couldn't revoke former.pm@example.com's GitHub access at GitHub");
  await expect(page.getByTestId("home-needs")).toContainText("Access");
  await github.getByRole("button", { name: "Retry" }).click();
  await expect(github).toHaveCount(0);
});

test("home: only owners see revokes a disable could not make", async ({ page }) => {
  await page.addInitScript(([key, role]) => localStorage.setItem(key, role), [MOCK_ROLE_KEY, "approver"] as const);
  await login(page);
  await page.goto("/home");
  await expect(page.getByTestId("home-needs-table")).toBeVisible();
  await expect(page.getByTestId("home-needs-table")).not.toContainText("Couldn't revoke");
});
