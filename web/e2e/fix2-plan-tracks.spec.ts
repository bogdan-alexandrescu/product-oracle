import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Fix round 2 for the Plan's PRD cards and track panel (qa-plan-1, -7, -30, -32, -34, -35, -53),
 * driven through the UI on the mock layer as an owner would, on a desktop (1440x900) and a phone
 * (390x844). The mock's Usage alerts track reads the Plan's own items (as the API's track
 * overview and Plan read the same roadmap items): seven items, one at risk, and its First
 * release milestone on Nov 30 (ENG-412) with the five Now items.
 */

const card = (page: Page, title: string) =>
  page.getByTestId("plan-prd-card").filter({ visible: true }).filter({ hasText: title });
const track = (page: Page) =>
  page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
const editor = (page: Page) => page.getByTestId("plan-milestone").filter({ visible: true });

async function openPlan(page: Page) {
  await login(page);
  await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(track(page)).toBeVisible();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } });

    // protects = qa-plan-1: the PRD card and its track panel give one status and one item count;
    // a change on the panel shows on the card; fails_when = the card says At risk while the panel
    // says On track, or the panel counts 2 items while the Plan lists 7.
    test(`a track's card and panel give one status and one item count (${where})`, async ({ page }) => {
      await openPlan(page);
      const c = card(page, "Usage alerts PRD");
      const t = track(page);
      await expect(c.getByTestId("plan-prd-figure")).toHaveText("At risk");
      await expect(t.getByTestId("track-health")).toHaveText("At risk");
      await expect(t).toContainText("At risk: 1 of 7 items needs attention");
      await expect(t).not.toContainText("On track");
      await t.getByRole("group", { name: "Track status" }).getByRole("button", { name: "Paused" }).click();
      await expect(t.getByTestId("track-health")).toHaveText("Paused");
      await expect(c.getByTestId("plan-prd-figure")).toHaveText("Paused");
      await t.getByRole("group", { name: "Track status" }).getByRole("button", { name: "Active" }).click();
      await expect(c.getByTestId("plan-prd-figure")).toHaveText("At risk");
    });

    // protects = qa-plan-53: every card's subtitle reads in one style, and a track's risk shows as
    // the same badge the track panel uses; fails_when = "waiting for you" is a blue link-coloured
    // line, or At risk is bare red text.
    test(`card subtitles share one style and risk is a badge (${where})`, async ({ page }) => {
      await openPlan(page);
      const waiting = card(page, "Saved carts PRD").getByTestId("plan-prd-stage");
      await expect(waiting).toHaveText("Feature set · waiting for you");
      const approved = card(page, "Usage alerts PRD").getByTestId("plan-prd-stage");
      const style = (el: Element) => {
        const s = getComputedStyle(el);
        return `${s.color} ${s.fontWeight}`;
      };
      expect(await waiting.evaluate(style)).toBe(await approved.evaluate(style));
      const badge = (el: Element) => {
        const s = getComputedStyle(el);
        return `${s.color} ${s.backgroundColor} ${s.borderRadius}`;
      };
      const figure = card(page, "Usage alerts PRD").getByTestId("plan-prd-figure");
      expect(await figure.evaluate(badge)).toBe(await track(page).getByTestId("track-health").evaluate(badge));
      expect(await figure.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    });

    // protects = qa-plan-30: a track with no owner reads "Owner: not set" next to Set owner;
    // fails_when = it reads "Owner No owner" next to Change owner.
    test(`a track with no owner reads not set, with Set owner (${where})`, async ({ page }) => {
      await openPlan(page);
      const t = track(page);
      await expect(t.getByTestId("track-owner")).toHaveText("not set");
      await expect(t.getByText("Owner:", { exact: true })).toBeVisible();
      await expect(t).not.toContainText("No owner");
      await expect(t.getByRole("button", { name: "Change owner" })).toHaveCount(0);
      await t.getByRole("button", { name: "Set owner" }).click();
      await t.getByLabel("Find a person").fill("approver");
      await t.getByRole("option", { name: /approver@example\.com/ }).click();
      await expect(t.getByTestId("track-owner")).toContainText("approver@example.com");
      await expect(t.getByRole("button", { name: "Change owner" })).toBeVisible();
    });

    // protects = qa-plan-32: the milestone row gives its date and its real item count, as the
    // track's headline names it; fails_when = "M1 · no date … Now · 1 item".
    test(`the milestone shows its date and its items (${where})`, async ({ page }) => {
      await openPlan(page);
      const t = track(page);
      const m1 = t.getByTestId("track-milestone").filter({ hasText: "First release" });
      await expect(m1.getByTestId("milestone-title")).toHaveText("M1 · Oct 19 – Nov 30");
      await expect(m1).toContainText("Now · 5 items");
      await expect(t).toContainText("Next milestone: First release, Nov 30.");
    });

    // protects = qa-plan-7, -35 and -34: New milestone is headed by its eyebrow alone, offers the
    // track's roadmap items by name, and puts Cancel left of Add milestone; fails_when = the
    // checklist lists PRD sections (Behaviour, Success metrics), the head reads "Milestone ·
    // selected / New milestone", or Add milestone sits left of Cancel.
    test(`New milestone offers the track's items, under one heading, Cancel first (${where})`, async ({ page }) => {
      await openPlan(page);
      await track(page).getByRole("button", { name: "Add milestone" }).click();
      const e = editor(page);
      await expect(e).toBeVisible();
      await expect(e).not.toContainText("Milestone · selected");
      await expect(e.getByText("New milestone", { exact: true })).toHaveCount(1);
      const items = e.getByRole("group", { name: "Items" });
      await expect(items.getByRole("checkbox", { name: /Threshold alerts on spend/ })).toBeVisible();
      await expect(items.getByRole("checkbox", { name: /Daily alert digest email/ })).toBeVisible();
      await expect(items.getByRole("checkbox", { name: /Budgets per team/ })).toBeVisible();
      await expect(items).not.toContainText("Behaviour");
      await expect(items).not.toContainText("Success metrics");
      const cancel = await e.getByRole("button", { name: "Cancel" }).boundingBox();
      const add = await e.getByRole("button", { name: "Add milestone" }).boundingBox();
      expect(cancel!.x + cancel!.width).toBeLessThanOrEqual(add!.x);
      // The new milestone keeps the items picked by name.
      await e.getByLabel("Name").fill("Digest beta");
      await items.getByRole("checkbox", { name: /Daily alert digest email/ }).check();
      await e.getByRole("button", { name: "Add milestone" }).click();
      const m2 = track(page).getByTestId("track-milestone").filter({ hasText: "Digest beta" });
      await expect(m2).toContainText("Now · 1 item");
      await expect(editor(page).getByRole("group", { name: "Items" }).getByRole("checkbox", { name: /Daily alert digest email/ })).toBeChecked();
    });
  });
}
