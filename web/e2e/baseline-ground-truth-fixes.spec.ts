import { expect, test } from "./test";
import type { Page } from "@playwright/test";

import { GROUND_TRUTH_FLAGS_SCENARIO } from "../lib/api/mock/ground-truth";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";

/**
 * The two Ground Truth fixes that had no route (the owner's follow-up, Nov 5), on Detailed's
 * Ground Truth page in the "ground-truth-flags" scenario: Give it a code (Smart search, no code:
 * the next F-number, F-21, past the roadmap's item from a PRD's F-20 section) and Link to a
 * feature for the PRD's F-09 Guest seats (its roadmap item F-09a Guest invites goes with it) and
 * the roadmap's slice item F-15a Usage report (an item link, a roadmap change; F-15b stays). Approvers and owners fix at once, with Undo; a commenter's fix goes to an
 * approver, who accepts it on the Proposals tab, and shows on its flag as waiting until then,
 * also after a reload; viewers read the flags with no fixes.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(page: Page, email?: string) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, GROUND_TRUTH_FLAGS_SCENARIO] as const);
  await login(page, email);
  await page.goto("/baseline");
  await expect(page.getByTestId("gt-band")).toBeVisible();
}

const count = (page: Page, kind: string) => page.getByTestId(`gt-count-${kind}`);
const total = (page: Page) => page.getByTestId("gt-total");
const row = (page: Page, name: string) => page.getByTestId("gt-row").filter({ hasText: name });
const notice = (page: Page) => page.getByTestId("gt-notice");

async function openKind(page: Page, kind: string) {
  await count(page, kind).click();
  await expect(page.getByTestId(`gt-list-${kind}`)).toBeVisible();
}

async function linkTo(page: Page, name: string, find: string, pick: string) {
  await row(page, name).getByRole("button", { name: /Link to a feature/ }).click();
  const picker = page.getByTestId("gt-picker");
  await picker.getByLabel("Find a feature").fill(find);
  await picker.getByRole("button", { name: pick }).click();
  await expect(picker).toHaveCount(0);
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [viewport, who] of [
  [DESKTOP, undefined],
  [PHONE, "approver@example.com"],
] as const)
  for (const colorScheme of ["light", "dark"] as const)
    test(`Give it a code gives the next F-number, then Undo (${viewport.width}, ${colorScheme}, ${who ?? "owner"})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await open(page, who);
      await expect(total(page)).toHaveText("9");
      await openKind(page, "no_code");
      await row(page, "Smart search").getByRole("button", { name: "Give it a code: Smart search" }).click();
      await expect(notice(page)).toContainText("“Smart search” is now F-21.");
      await expect(count(page, "no_code")).toHaveCount(0);
      await expect(total(page)).toHaveText("8");
      expect(await fits(page)).toBe(true);
      await notice(page).getByRole("button", { name: "Undo" }).click();
      await expect(notice(page)).toContainText("Undone.");
      await expect(count(page, "no_code")).toContainText("1");
      await expect(total(page)).toHaveText("9");
    });

for (const [viewport, who] of [
  [DESKTOP, "approver@example.com"],
  [PHONE, undefined],
] as const)
  for (const colorScheme of ["light", "dark"] as const)
    test(`Link to a feature links the PRD's feature and its slice, then Undo (${viewport.width}, ${colorScheme}, ${who ?? "owner"})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await open(page, who);
      await openKind(page, "prd_feature_missing");
      await linkTo(page, "Guest seats", "F-12", "F-12 Digest emails");
      await expect(notice(page)).toContainText("Linked “Guest seats” to “Digest emails”.");
      await expect(count(page, "prd_feature_missing")).toHaveCount(0);
      // Its roadmap item F-09a is the linked feature's now: not flagged either.
      await expect(count(page, "unlinked_item")).toContainText("2");
      await expect(total(page)).toHaveText("7");
      await notice(page).getByRole("button", { name: "Undo" }).click();
      await expect(count(page, "prd_feature_missing")).toContainText("1");
      await expect(total(page)).toHaveText("9");
      // The slice is a roadmap item (F-15a): linking it is a roadmap change, which an approver
      // who does not edit the roadmap sends for approval.
      await openKind(page, "slice_parent_missing");
      await linkTo(page, "Usage report", "Sheets", "F-11 Sheets export");
      if (who) {
        await expect(notice(page)).toContainText("Sent linking “Usage report” to “Sheets export” for approval.");
        await expect(count(page, "slice_parent_missing")).toContainText("2");
        await expect(total(page)).toHaveText("9");
      } else {
        // The item is linked; the other slice, F-15b Usage chart, is still flagged.
        await expect(notice(page)).toContainText("Linked “Usage report” to “Sheets export”.");
        await expect(count(page, "slice_parent_missing")).toContainText("1");
        await expect(row(page, "Usage chart")).toContainText("F-15b");
        await expect(total(page)).toHaveText("8");
      }
      expect(await fits(page)).toBe(true);
    });

for (const [viewport, colorScheme] of [
  [DESKTOP, "light"],
  [PHONE, "dark"],
] as const)
  test(`a commenter's fixes go to an approver, who accepts them (${viewport.width}, ${colorScheme})`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme });
    await open(page, "commenter@example.com");
    await openKind(page, "no_code");
    await row(page, "Smart search").getByRole("button", { name: /Give it a code/ }).click();
    await expect(notice(page)).toContainText("Asked an approver to give “Smart search” a code.");
    await expect(notice(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(count(page, "no_code")).toContainText("1");
    await openKind(page, "prd_feature_missing");
    await linkTo(page, "Guest seats", "Audit", "F-02 Audit log");
    await expect(notice(page)).toContainText("Asked an approver to link “Guest seats” to “Audit log”.");
    await expect(total(page)).toHaveText("9");
    // Each stays on its flag as waiting for an approver, with no second ask, also after a reload.
    await page.reload();
    await expect(page.getByTestId("gt-band")).toBeVisible();
    for (const [kind, name, fix] of [
      ["no_code", "Smart search", /Give it a code/],
      ["prd_feature_missing", "Guest seats", /Link to a feature/],
    ] as const) {
      await openKind(page, kind);
      await expect(row(page, name).getByTestId("gt-pending")).toHaveText("Waiting for an approver");
      await expect(row(page, name).getByRole("button", { name: fix })).toHaveCount(0);
    }

    // The account menu sits in the rail, which a phone folds away: sign out on a wide screen.
    await page.setViewportSize(DESKTOP);
    await signOut(page);
    await login(page, "approver@example.com");
    await page.setViewportSize(viewport);
    await page.goto("/baseline?tab=proposals");
    const proposals = page.getByTestId("proposal");
    for (const summary of ["Give “Smart search” a feature code", "Link the PRD’s F-09 Guest seats to “Audit log”"]) {
      const accept = proposals.filter({ hasText: summary }).getByRole("button", { name: "Accept" });
      await accept.click();
      await expect(accept).toHaveCount(0);
    }
    await page.goto("/baseline");
    await expect(page.getByTestId("gt-band")).toBeVisible();
    await expect(count(page, "no_code")).toHaveCount(0);
    await expect(count(page, "prd_feature_missing")).toHaveCount(0);
    await expect(total(page)).toHaveText("6");
  });

for (const viewport of [DESKTOP, PHONE])
  test(`a viewer reads these flags with no fixes (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport === PHONE ? "dark" : "light" });
    await open(page, "viewer@example.com");
    for (const kind of ["no_code", "prd_feature_missing", "slice_parent_missing"]) {
      await openKind(page, kind);
      await expect(page.getByTestId(`gt-list-${kind}`).getByTestId("gt-row").first()).toBeVisible();
      await expect(page.getByTestId(`gt-list-${kind}`).getByRole("button")).toHaveCount(0);
    }
  });
