import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";
import { countRowOf } from "./vxe-counts";

/*
 * Simple priorities, QA pass 4 (qa4-simple-plan-11, the owner's pick "Letters from the
 * name"): a feature with no real F-NN code shows the initials of its shown name (Alert routing
 * by team ARB), never of its internal key (alert-sso AS); a real code stays (F-12). A rename
 * from the Ask panel moves the letters with the name (Team alert routing TAR) on the list and
 * on the Value / effort marks; a name with a number keeps it (Alert routing 2 AR2). Desktop
 * (1366x820) and a phone (390x844).
 */

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

// prio-company (the owner, Nov 4): the ranked rows show no made-up letters, only a real code beside
// the name; the letters stay on Value / effort, where a mark and its side row read alike.
const code = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="side-row"][data-code="${key}"]`).getByTestId("side-code");

async function rowsNameNoLetters(page: Page): Promise<void> {
  await page.goto("/simple/priorities");
  await expect(page.locator('[data-testid="prio-row"][data-code="setup-import"]').getByTestId("prio-own-key")).toHaveText("F-12");
  await expect(page.locator('[data-testid="prio-row"][data-code="alert-sso"]').getByTestId("prio-own-key")).toHaveCount(0);
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

    test(`a feature without a real code shows its name's letters, and a rename changes them (${where})`, async ({ page }) => {
      // protects: qa4-simple-plan-11: Alert routing by team reads ARB (its name's initials), Sample data import keeps its real code F-12; renamed Team alert routing, it reads TAR on the list and its mark
      // fails_when: a code comes from the internal key (AS), a real code turns into letters, or a rename leaves the old letters
      // no_claim: the API's rule (pytest test_short_codes_take_the_letters_of_the_shown_name, test_short_codes_follow_a_rename)
      await login(page);
      await rowsNameNoLetters(page);
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(code(page, "alert-sso")).toHaveText("ARB");
      await expect(code(page, "alert-sso")).toHaveAttribute("title", "Alert routing by team");
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
      await expect(code(page, "alert-sso")).toHaveText("TAR");
      await expect(code(page, "alert-sso")).toHaveAttribute("title", "Team alert routing");
      await expect(code(page, "setup-import")).toHaveText("F-12");
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(mark(page, "alert-sso")).toHaveText("TAR");
      // PV-1: on a phone F-12's mark is in a count (with Alert rules engine): its row in the count's sheet reads the code.
      if (phone) await expect((await countRowOf(page, "setup-import")).getByTestId("vxe-crowd-code")).toHaveText("F-12");
      else await expect(mark(page, "setup-import")).toHaveText("F-12");
    });

    test(`a name with a number keeps the number in its code (${where})`, async ({ page }) => {
      // protects: review minor of codes-from-names: renamed Alert routing 2, the feature reads AR2 (its letters, then its number), never AR with the number dropped
      // fails_when: the code drops the name's number, or a real code turns into letters
      // no_claim: the API's rule (pytest test_short_codes_keep_the_number_in_a_name)
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
      await expect(code(page, "alert-sso")).toHaveText("AR2");
      await expect(code(page, "alert-sso")).toHaveAttribute("title", "Alert routing 2");
      await expect(code(page, "setup-import")).toHaveText("F-12");
      await page.goto("/simple/priorities?tab=value-effort");
      await expect(mark(page, "alert-sso")).toHaveText("AR2");
    });
  });
}
