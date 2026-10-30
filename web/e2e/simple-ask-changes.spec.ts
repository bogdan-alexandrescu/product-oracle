import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN } from "./helpers";

/*
 * Simple S9 direction A: the Ask panel on Simple's pages offers change by chat, under the
 * person's own permissions, in the "simple-chat" mock scenario (the default company's owner,
 * commenter and viewer). Every test runs on desktop (1366x820) and on a phone (390x844); one
 * runs in dark.
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;

async function signIn(page: Page, email: string, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
  // A phone's Timeline (timeline-overlap B3) draws thin lanes with no bars: a phone reads the bar's dates on the Gantt.
  if (to === "/simple/roadmap" && (page.viewportSize()?.width ?? 1366) <= 640) await tap(page.getByTestId("format-gantt"));
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone) and answers its change-by-chat section. */
async function openAsk(page: Page, phone: boolean) {
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();
  return ask;
}

async function say(ask: ReturnType<Page["getByTestId"]>, text: string) {
  await ask.getByLabel("Message Oracle").fill(text);
  await tap(ask.getByRole("button", { name: "Send" }));
}

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.beforeEach(async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
    });

    test(`the owner previews, discards, applies and undoes from the Ask panel (${where})`, async ({ page }) => {
      // protects: on the roadmap the owner's card ghosts the bar at the new dates on Preview (desktop: the chart beside the panel), Reject (roadmap-talk: every roadmap card) clears the ghost and writes nothing, Apply (the owner decides) applies with "Applied by", Undo undoes it
      // fails_when: no ghost, the ghost stays after Reject, the owner's button says Propose, or Undo leaves the change
      // no_claim: the ghost's exact geometry; on a phone the full-height sheet hides the chart, so the ghost is checked on desktop only
      await signIn(page, EMAILS.owner, "/simple/roadmap");
      const bar = page.locator('[data-testid="bar"][data-item="alert-digest"]');
      const start = await bar.getAttribute("data-start");
      const ask = await openAsk(page, phone);
      await say(ask, "move Weekly alert digest to Q2");
      const card = ask.getByTestId("chat-card").filter({ hasText: "Move Weekly alert digest to Apr 1" });
      await expect(card.getByRole("button", { name: "Apply" })).toBeEnabled();
      await tap(card.getByRole("button", { name: "Preview" }));
      if (!phone) {
        await expect(page.getByTestId("preview-ghost")).toHaveAttribute("data-start", "2027-04-01");
      }
      await tap(card.getByRole("button", { name: "Reject" }));
      await expect(card.getByTestId("chat-card-outcome")).toHaveText("Rejected: nothing changed");
      await expect(page.getByTestId("preview-ghost")).toHaveCount(0);
      await expect(bar).toHaveAttribute("data-start", start!);

      await say(ask, "rename Weekly alert digest to Weekly alert summary");
      const rename = ask.getByTestId("chat-card").filter({ hasText: "Rename Weekly alert digest" });
      await tap(rename.getByRole("button", { name: "Apply" }));
      await expect(rename.getByTestId("chat-card-outcome")).toContainText("Applied by you");
      await expect(rename.getByTestId("chat-card-decision")).toHaveCount(0);
      await tap(rename.getByRole("button", { name: "Undo" }));
      await expect(rename.getByTestId("chat-card-outcome")).toContainText("Undone");
    });

    test(`a commenter's cards propose, with the flow or "No flow yet" (${where})`, async ({ page }) => {
      // protects: under a commenter's own permissions a roadmap card's button is Propose and the result says to whom; a feature ask (theirs to file) says Apply and shows its flow thumbnail that widens to the flow, a task "No flow yet"; a move that breaks a link shows the red reason and a one-click fix
      // fails_when: a commenter applies directly, the flow is missing, or the broken link has no reason in red
      // no_claim: the deciders' routing beyond the default company (simple-deciders.spec.ts)
      await signIn(page, EMAILS.commenter, "/simple");
      const ask = await openAsk(page, phone);
      await say(ask, "rename Setup checklist to First-run checklist");
      const card = ask.getByTestId("chat-card").filter({ hasText: "Rename Setup checklist" });
      await tap(card.getByRole("button", { name: "Propose" }));
      await expect(card.getByTestId("chat-card-outcome")).toContainText("Proposed to Admin by you");

      await say(ask, "feature ask from Rosa Imani: Snooze alerts for a day");
      const askCard = ask.getByTestId("chat-card").filter({ hasText: "New feature ask from Rosa Imani: Snooze alerts for a day" });
      await tap(askCard.getByTestId("flow-thumb"));
      await expect(askCard.getByTestId("flow-detail")).toContainText("User flow: Snooze alerts for a day");
      // Filing a feature ask is every commenter's right: it applies, not proposes.
      await expect(askCard.getByRole("button", { name: "Apply" })).toBeEnabled();

      await say(ask, "add a task 'Draft the email' to Weekly alert digest");
      await expect(ask.getByTestId("chat-card").filter({ hasText: "Add the task “Draft the email”" }).getByTestId("flow-none")).toHaveText("No flow yet");

      await say(ask, "move Mobile alert push to October 25");
      const late = ask.getByTestId("chat-card").filter({ hasText: "Move Mobile alert push" });
      await expect(late.getByTestId("chat-card-flag").first()).toBeVisible();
      await expect(late.getByTestId("chat-card-fix").first()).toHaveText("Propose: Start Mobile alert push after Alert rules engine ends");
    });
  });
}

test.describe("desktop, dark", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addInitScript(
      ([key, themeKey]) => {
        localStorage.setItem(key, "simple-chat");
        localStorage.setItem(themeKey, "dark");
      },
      [MOCK_SCENARIO_KEY, THEME_KEY],
    );
    await page.emulateMedia({ colorScheme: "dark" });
  });

  test("a viewer's cards are disabled with why; Detailed's panel is unchanged (desktop, dark)", async ({ page }) => {
    // protects: a viewer may ask but their card's Apply is disabled with the reason; outside Simple the Ask panel has no change-by-chat section
    // fails_when: a viewer's card is actionable, or Detailed's panel grows the Simple section
    // no_claim: Detailed's chats themselves (hop-panel specs)
    await signIn(page, EMAILS.viewer, "/simple");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const ask = await openAsk(page, false);
    await expect(ask.getByTestId("chat-hint")).toContainText("You can ask questions");
    await say(ask, "cut Alert history export");
    const card = ask.getByTestId("chat-card").filter({ hasText: "Cut Alert history export" });
    // fix4 qa-simple-roadmap-24: a cut whose dependents stay red names that on its button.
    await expect(card.getByRole("button", { name: "Cut it, keep the dependents" })).toBeDisabled();
    // fix5-cut-dependents: so is its second button, cutting the dependents too.
    await expect(card.getByRole("button", { name: "Cut it and its dependents" })).toBeDisabled();
    await expect(card.getByTestId("chat-card-why-not")).toHaveText("Viewers read the plan; they don't change it");
    await page.goto("/home");
    // The panel's open state carries over from Simple; open it only if it is closed.
    // The open state may settle after the first paint: retry until the panel shows.
    const strip = page.getByTestId("hop-strip");
    await expect(async () => {
      if ((await strip.getAttribute("aria-expanded")) !== "true") await strip.click({ timeout: 2000 });
      await expect(page.getByTestId("hop-panel").filter({ visible: true })).toBeVisible({ timeout: 2000 });
    }).toPass();
    await expect(page.getByTestId("ask-chat")).toHaveCount(0);
  });
});
