import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";
import { countRowOf } from "./vxe-counts";

/*
 * Simple priorities: a feature shows its real Ground Truth code (F-12) or none, never letters made up from its name
 * (PR1, QA Nov 12, 2026, replacing qa4-simple-plan-11's "Letters from the name"). A rename from the Ask panel
 * brings no letters either (Team alert routing, Alert routing 2). Desktop (1366x820) and a phone (390x844).
 */

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

// prio-company (the owner, Nov 4): the ranked rows show no made-up letters, only a real code beside
// the name; the letters stay on Value / effort, where a mark and its side row read alike.
const side = (page: Page, key: string): Locator => page.locator(`[data-testid="side-row"][data-code="${key}"]`);
const code = (page: Page, key: string): Locator => side(page, key).getByTestId("side-code");

async function rowsNameNoLetters(page: Page): Promise<void> {
  await page.goto("/simple/priorities");
  await expect(page.locator('[data-testid="prio-row"][data-code="setup-import"]').getByTestId("prio-own-key")).toHaveText("F-12");
  // seed codes: Alert routing by team now carries its real Ground Truth code F-89, never letters made up from its name.
  await expect(page.locator('[data-testid="prio-row"][data-code="alert-sso"]').getByTestId("prio-own-key")).toHaveText("F-89");
  await expect(page.getByTestId("prio-code")).toHaveCount(0);
}

const mark = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="vxe-point"][data-code="${key}"]`).getByTestId("vxe-code");

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ page }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`a feature without a real code shows no made-up letters, before or after a rename (${where})`, async ({ page }) => {
      // protects: PR1 (QA Nov 12, replacing qa4-simple-plan-11's letters): Alert routing by team keeps its real Ground Truth code F-89, never letters made up from its name (never ARB); Sample data import keeps its real code F-12; renamed Team alert routing, it still reads F-89 (never TAR) on the list and its mark
      // fails_when: a code is made up from the name or the internal key, a real code turns into letters, or a rename brings letters
      // no_claim: the API's short_code rule (Priorities shows own_key only)
      await login(page);
      await rowsNameNoLetters(page);
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(side(page, "alert-sso").getByTestId("prio-title")).toHaveText("Alert routing by team");
      await expect(code(page, "alert-sso")).toHaveText("F-89");
      await expect(code(page, "setup-import")).toHaveText("F-12");

      await page.goto("/simple/roadmap");
      await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const ask = page.getByTestId("ask-chat").filter({ visible: true });
      await ask.getByLabel("Message Oracle").fill("rename Alert routing by team to Team alert routing");
      await tap(ask.getByRole("button", { name: "Send" }));
      const card = ask.getByTestId("chat-card").filter({ hasText: "Rename Alert routing by team" });
      await tap(card.getByRole("button", { name: "Apply" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");

      await page.goto("/simple/priorities?tab=value-effort");
      await expect(side(page, "alert-sso").getByTestId("prio-title")).toHaveText("Team alert routing");
      await expect(code(page, "alert-sso")).toHaveText("F-89");
      await expect(code(page, "setup-import")).toHaveText("F-12");
      await expect(mark(page, "alert-sso")).toHaveText("F-89");
      // PV-1: on a phone F-12's mark is in a count (with Alert rules engine): its row in the count's sheet reads the code.
      if (phone) await expect((await countRowOf(page, "setup-import")).getByTestId("vxe-crowd-code")).toHaveText("F-12");
      else await expect(mark(page, "setup-import")).toHaveText("F-12");
    });

    test(`a name with a number gets no made-up code either (${where})`, async ({ page }) => {
      // protects: PR1 (QA Nov 12): renamed Alert routing 2, the feature still shows its real code F-89 (never AR2), and F-12 stays
      // fails_when: a code is made up from the name, or a real code turns into letters
      // no_claim: the API's short_code rule (Priorities shows own_key only)
      await login(page);
      await page.goto("/simple/roadmap");
      await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const ask = page.getByTestId("ask-chat").filter({ visible: true });
      await ask.getByLabel("Message Oracle").fill("rename Alert routing by team to Alert routing 2");
      await tap(ask.getByRole("button", { name: "Send" }));
      const card = ask.getByTestId("chat-card").filter({ hasText: "Rename Alert routing by team" });
      await tap(card.getByRole("button", { name: "Apply" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");

      await page.goto("/simple/priorities?tab=value-effort");
      await expect(side(page, "alert-sso").getByTestId("prio-title")).toHaveText("Alert routing 2");
      await expect(code(page, "alert-sso")).toHaveText("F-89");
      await expect(code(page, "setup-import")).toHaveText("F-12");
      await expect(mark(page, "alert-sso")).toHaveText("F-89");
    });
  });
}
