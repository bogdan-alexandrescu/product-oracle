import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * The owner's production walk (2026-10-27): flows show up when drawn, the Ask thread belongs
 * to the page, the PRD's F-codes, plain labels. Driven through the UI on the mock's invented
 * data (./lib/api/mock/simple-visuals.ts, simple-chat.ts, simple-roadmap.ts,
 * simple-meetings.ts), on desktop (1366x820) and phone (390x844), light and dark.
 *
 * Card walk-flow-drawn: protects = an owner asks Oracle to draw a roadmap item's flow from
 * its card; the card says Oracle is drawing, then shows version 1 without a reload, and the
 * card's Flow line names the drawn flow instead of "No flow yet" once the flow is closed; a
 * one-pager bet's thumbnail shows its drawn flow without a reload; fails_when = the drawing
 * state stays until a reload, or the place that asked keeps "No flow yet"; no_claim = the
 * job's queueing and the drawing's lines (api/tests/test_simple_walk_fixes_api.py).
 *
 * Card walk-flow-failed: protects = a drawing job that ends without a drawing turns the
 * card's drawing state into "Oracle could not draw the flow" with Retry, and Retry draws
 * version 1; fails_when = a failed job leaves "Oracle is drawing…" forever or offers no
 * Retry; no_claim = why the model's drawing failed (the job's tests).
 *
 * Card walk-ask-per-page: protects = a line asked in the Ask panel on the Roadmap stays in
 * the Roadmap's thread; opening Ask on Priorities shows an empty thread, and back on the
 * Roadmap the line is there again; the chip and placeholder name the page ("About: Roadmap",
 * "About: Home"), never its route; fails_when = one thread follows the person across pages,
 * or the chip shows "/simple"; no_claim = meeting chats (simple-chat.spec.ts) and the API's
 * keying per role (api/tests/test_simple_walk_fixes_api.py).
 *
 * Card walk-prd-code: protects = an item imported from the PRD's section f-06 reads F-06 in
 * its card's reasons ("F-06 Weekly digest of fired alerts"), never "section f-06";
 * fails_when = the section key shows raw; no_claim = priorities' rows and marks
 * (simple-priorities-codes.spec.ts).
 *
 * Card walk-ritual-attendees: protects = after an owner starts a scheduled review with an
 * extra attendee, Home's "Next review meeting" lists the ritual's real attendees, the extra
 * one included; fails_when = the card counts only the ritual's configured attendees;
 * no_claim = Detailed's ritual settings.
 */

const DESKTOP = { width: 1366, height: 820 };
const PHONE = { width: 390, height: 844 };

const bar = (page: Page, key: string): Locator => page.locator(`g[data-testid="bar"][data-item="${key}"]`);

/** Clicks `l` once it is scrolled to the middle (on a phone the tab bar covers the bottom of the screen). */
async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** Opens Ask Oracle (the rail's button; the header's Ask on a phone): the visible panel. */
async function openAsk(page: Page, phone: boolean) {
  await expect(page.getByTestId("simple-home").or(page.locator("main")).first()).toBeVisible();
  if (await page.getByTestId("hop-panel").filter({ visible: true }).getByTestId("ask-chat").isVisible()) return page.getByTestId("hop-panel").filter({ visible: true });
  await tap(page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await expect(panel.getByTestId("ask-chat")).toBeVisible();
  return panel;
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;
    test.describe(where, () => {
      test.use({ viewport: phone ? PHONE : DESKTOP, colorScheme: scheme, hasTouch: phone, isMobile: phone });

      test(`a roadmap item's flow shows up when drawn, without a reload (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/roadmap");
        await expect(bar(page, "alert-digest")).toBeVisible();
        await bar(page, "alert-digest").click();
        const card = page.getByTestId("floating-card");
        await expect(card.getByTestId("card-flow")).toContainText("No flow yet");
        await tap(card.getByRole("button", { name: "Open the item's flow" }));
        await tap(card.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(card.getByTestId("flow-empty")).toContainText("Oracle is drawing the user flow");
        await expect(card.getByTestId("flow-version")).toHaveText("Version 1 of 1");
        await expect(card.getByTestId("flow-svg")).toBeVisible();
        await tap(card.getByRole("button", { name: "Close the flow" }));
        await expect(card.getByTestId("card-flow")).not.toContainText("No flow yet");
      });

      test(`a one-pager bet's thumbnail shows its drawn flow without a reload (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/prds/guided-setup");
        const thumb = page.getByRole("button", { name: "Flow for bet 3" });
        await expect(thumb).toContainText("No flow yet");
        await tap(thumb);
        const wide = page.getByRole("group", { name: "User flow of bet 3" });
        await tap(wide.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(wide.getByTestId("flow-empty")).toContainText("Oracle is drawing the user flow");
        await expect(wide.getByTestId("flow-version")).toHaveText("Version 1 of 1");
        await tap(wide.getByRole("button", { name: "Close the flow" }));
        await expect(thumb).not.toContainText("No flow yet");
      });

      test(`a drawing that fails says so and Retry draws it (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple/roadmap");
        await expect(bar(page, "alert-export")).toBeVisible();
        await bar(page, "alert-export").click();
        const card = page.getByTestId("floating-card");
        await tap(card.getByRole("button", { name: "Open the item's flow" }));
        await tap(card.getByRole("button", { name: "Ask Oracle to draw it" }));
        await expect(card.getByTestId("flow-empty")).toContainText("Oracle could not draw the flow");
        await expect(card.getByTestId("flow-empty")).not.toContainText("Oracle is drawing");
        await tap(card.getByRole("button", { name: "Retry" }));
        await expect(card.getByTestId("flow-version")).toHaveText("Version 1 of 1");
        await expect(card.getByTestId("flow-svg")).toBeVisible();
      });

      test(`the item card names the PRD's F-code, not the section key (${where})`, async ({ page }) => {
        await login(page, "viewer@example.com");
        await page.goto("/simple/roadmap");
        await expect(bar(page, "alert-digest")).toBeVisible();
        await bar(page, "alert-digest").click();
        const reasons = page.getByTestId("floating-card").getByTestId("card-reasons");
        await expect(reasons).toContainText("F-06 Weekly digest of fired alerts.");
        await expect(reasons).not.toContainText("section f-06");
      });

      for (const email of ["admin@example.com", "commenter@example.com", "viewer@example.com"]) {
        test(`${email.split("@")[0]}: the Ask thread belongs to the page, its chip names the page (${where})`, async ({ context, page }) => {
          await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
          await login(page, email);
          await page.goto("/simple/roadmap");
          let panel = await openAsk(page, phone);
          await expect(panel.getByText("About: Roadmap")).toBeVisible();
          await expect(panel.getByText("About: /simple/roadmap")).toHaveCount(0);
          await panel.getByRole("textbox", { name: "Message Oracle" }).fill("who owns Weekly alert digest?");
          await tap(panel.getByRole("button", { name: "Send" }));
          const thread = panel.getByTestId("ask-chat-thread");
          await expect(thread.getByTestId("chat-message").filter({ hasText: "who owns Weekly alert digest?" })).toHaveCount(1);

          await page.goto("/simple/priorities");
          panel = await openAsk(page, phone);
          await expect(panel.getByText("About: Priorities")).toBeVisible();
          await expect(panel.getByText("who owns Weekly alert digest?")).toHaveCount(0);

          await page.goto("/simple");
          panel = await openAsk(page, phone);
          await expect(panel.getByText("About: Home")).toBeVisible();
          await expect(panel.getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", /^Ask about Home/);
          await expect(panel.getByText("who owns Weekly alert digest?")).toHaveCount(0);

          await page.goto("/simple/roadmap");
          panel = await openAsk(page, phone);
          await expect(panel.getByTestId("ask-chat-thread").getByTestId("chat-message").filter({ hasText: "who owns Weekly alert digest?" })).toHaveCount(1);
        });
      }

      test(`Home's next review lists the ritual's real attendees (${where})`, async ({ page }) => {
        await login(page);
        await page.goto("/simple");
        const next = page.getByTestId("home-meeting-next");
        await expect(next).toBeVisible();
        await expect(next).not.toContainText("Commenter");
        await page.goto("/simple/meetings");
        // The soonest scheduled review, the one Home shows.
        await tap(page.getByRole("region", { name: "Upcoming" }).getByRole("button", { name: "Start review" }).first());
        const sheet = page.getByRole("dialog", { name: "Start a review" });
        await sheet.getByRole("checkbox", { name: "Commenter" }).check();
        await sheet.getByRole("button", { name: "Start", exact: true }).click();
        await expect(page.getByLabel("Attendees")).toContainText("Commenter");
        await page.goto("/simple");
        await expect(page.getByTestId("home-meeting-next")).toContainText("Commenter");
      });
    });
  }
}
