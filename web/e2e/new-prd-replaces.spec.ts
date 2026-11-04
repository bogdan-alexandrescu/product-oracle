import { expect, test, type Page } from "./test";

import { REPLACED_PRD_SCENARIO } from "../lib/api/mock/replaced-prd";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Simple › New PRD › Replaces (new-prd-from-replaced-prd, owner Nov 4): a new PRD can start
 * from an approved PRD it replaces. Picking it, naming the area and ticking its items in
 * that area shows, before Start, what the draft carries: the PRD's standing decisions (a
 * reversed one named as left out) and its verified estimates and commitments for those
 * items only. The brief made says the same. Desktop and phone; invented example data.
 *
 * Test cards:
 * - "carried before Start": protects=the Replaces field lists approved PRDs only, asks for
 *   the area, and shows the carried decisions and the area items' verified estimates (not a
 *   proposed one, not an item outside the area) before Next; fails_when=the field is
 *   missing, a draft PRD is offered, a reversed decision or an out-of-area estimate is
 *   shown, or nothing shows before Start; no_claim=the run's prompt and the critic (pytest
 *   test_new_prd_from_replaced_prd).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const NAME = "Usage alerts: safety";
const PROBLEM = "Teams get flooded with alerts during an outage, so they mute them and miss the ones that matter.";
const OLD = "Usage alerts PRD";

const sheet = (page: Page) => page.getByTestId("np-sheet");

async function open(page: Page) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, REPLACED_PRD_SCENARIO] as const);
  await login(page);
  await page.goto("/simple");
  await expect(page.getByTestId("simple-page")).toBeVisible();
  await page.getByTestId("simple-page").getByRole("button", { name: "New PRD" }).click();
  await expect(sheet(page)).toBeVisible();
}

for (const [label, size] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(label, () => {
    test.use({ viewport: size });

    test("carried before Start: picking the PRD it replaces shows its decisions and the area's verified estimates", async ({ page }) => {
      await open(page);
      const s = sheet(page);
      await s.getByLabel("Name").fill(NAME);
      await s.getByLabel("The problem").fill(PROBLEM);

      const replaces = s.getByRole("group", { name: /Replaces/ });
      const pick = replaces.getByLabel("Approved PRD it replaces");
      // Approved PRDs only: Usage alerts is approved, Checkout redesign is not.
      await expect(pick.locator("option", { hasText: OLD })).toHaveCount(1);
      await expect(pick.locator("option", { hasText: "Checkout redesign PRD" })).toHaveCount(0);
      await expect(replaces.getByTestId("np-carried")).toHaveCount(0);
      await pick.selectOption({ label: OLD });

      // The area is asked for; Next waits for it.
      const next = s.getByRole("button", { name: "Next" });
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await replaces.getByLabel("Area", { exact: true }).fill("Alert Safety");
      await replaces.getByLabel("What the area covers, in one line").fill("caps, quiet hours and alert floods");
      await expect(next).toHaveAttribute("aria-disabled", "false");

      // The standing decisions are carried; the reversed one is named as left out.
      const carried = replaces.getByTestId("np-carried");
      await expect(carried.getByText(`Carried from ${OLD}`)).toBeVisible();
      const decisions = carried.getByTestId("np-carried-decisions");
      await expect(decisions.getByRole("listitem")).toHaveCount(2);
      await expect(decisions).toContainText("Cut voice notes from the first release");
      await expect(decisions).toContainText("Cap alerts at 30 a minute");
      await expect(decisions).not.toContainText("Drop email alerts");
      await expect(carried.getByTestId("np-carried-left-out")).toContainText("Drop email alerts (reversed)");
      await expect(carried.getByText("Pick its items in this area to carry their estimates.")).toBeVisible();

      // Tick two of its three items: their verified estimates come, nothing else.
      const items = replaces.getByRole("button", { pressed: false });
      await expect(items).toHaveCount(3);
      const titles = await items.allInnerTexts();
      await items.filter({ hasText: titles[0]!.trim() }).click();
      await replaces.getByRole("button", { name: titles[1]!.trim(), exact: true }).click();
      await expect(replaces.getByRole("button", { pressed: true })).toHaveCount(2);
      const estimates = carried.getByTestId("np-carried-estimates");
      await expect(estimates.getByRole("listitem")).toHaveCount(2);
      await expect(estimates).toContainText(`Estimate EX-101 for ${titles[0]!.trim()}: Dec 15, 2026`);
      await expect(estimates).toContainText(`Commitment Q4 safety plan for ${titles[1]!.trim()}: Nov 30, 2026`);
      await expect(estimates).not.toContainText("EX-102");
      await expect(estimates).not.toContainText("EX-303");
      await expect(carried).not.toContainText("2026-12-15");

      // Start: the brief says what it carries.
      await next.click();
      await expect(s.getByRole("heading", { name: NAME })).toBeVisible();
      const brief = s.getByTestId("np-carried");
      await expect(brief.getByText(`Carried from ${OLD}`)).toBeVisible();
      await expect(brief.getByTestId("np-carried-decisions").getByRole("listitem")).toHaveCount(2);
      await expect(brief.getByTestId("np-carried-estimates").getByRole("listitem")).toHaveCount(2);
    });
  });
}
