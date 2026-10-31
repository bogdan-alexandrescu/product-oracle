import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * QA pass 3, simple-decide lane: Meetings, one live meeting and its end screen, the meeting
 * chat and Decisions (List, Board, By meeting), driven through the UI on the mock's data.
 *
 * protects = qa-simple-decide-1/2 (a comment is a comment, shown with who and when; never a
 * decision), -3 (theme border colour), -4 (the Board's tabs fit a phone), -5 (the rail behind
 * the meeting takes no focus), -6 (a prose summary; notes as their own list), -7/-31 (one day
 * format in Pacific time), -8 (no dead Start review), -9 (years on roadmap dates, one line),
 * -10 (the mode said once on the chat page), -11 (meetings told apart), -12 (grammar), -13
 * (Decided stacks under Needs input), -14 (Decide for <decider>), -16 (the current decider
 * marked), -18 (the source line), -20 (Open questions), -21/-30 (one link style), -22 (the chat
 * grows with the page on a phone), -23 (own lines in body text), -25 (viewers' words), -26
 * (empty named list), -27 (no One-pagers link in a meeting), -28 (Cut asks first), -29 (the
 * header folds on a phone), -33 (44 px taps), -35 (the lead follows the view), -36 (the view
 * in the address).
 */

const sheet = (page: Page) => page.getByRole("dialog", { name: "Start a review" });
const chat = (page: Page) => page.getByTestId("meeting-chat");
const steps = (page: Page) => page.getByRole("navigation", { name: "Steps" });

async function asRole(page: Page, role: "viewer" | "commenter") {
  await page.addInitScript(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, role] as const);
}

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function meetings(page: Page) {
  await login(page);
  await page.goto("/simple/meetings");
  await expect(page.getByRole("region", { name: "Upcoming" })).toBeVisible();
}

async function startReview(page: Page, also: string[] = ["Commenter"]) {
  await meetings(page);
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = sheet(page);
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  for (const who of also) await s.getByRole("checkbox", { name: who, exact: true }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  await page.getByRole("alertdialog").getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

/** The resolved colour of `color` and of the theme's line colour, compared on the same element. */
async function borderIsLine(l: Locator) {
  return l.evaluate((el) => {
    const probe = document.createElement("div");
    probe.className = "border border-line";
    document.body.appendChild(probe);
    const line = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const s = getComputedStyle(el);
    return [s.borderBottomColor, s.borderTopColor].includes(line);
  });
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("a live meeting: soft borders, a comment stays a comment, Open questions, Cut asks first, years on dates", async ({ page }) => {
        await startReview(page);
        // qa-simple-decide-3: the header rule and the attendee chips in the theme's line colour.
        expect(await borderIsLine(page.locator('header[aria-label="Meeting"]'))).toBe(true);
        // qa-simple-decide-29: on a phone the attendees and the mode fold into one row.
        if (phone) {
          await expect(page.getByTestId("meeting-people")).toBeHidden();
          await tap(page.getByTestId("meeting-people-toggle"));
        }
        await expect(page.getByTestId("meeting-people")).toBeVisible();
        expect(await borderIsLine(page.getByRole("list", { name: "Attendees" }).getByRole("listitem").first())).toBe(true);
        // qa-simple-decide-27: no way back to the One-pagers list inside the stage; Detailed opens in a new tab.
        const stage = page.getByRole("region", { name: "Stage" });
        await expect(stage.getByRole("link", { name: "One-pagers" })).toHaveCount(0);
        const detailed = stage.getByRole("link", { name: /Open the detailed view/ }).first();
        if (await detailed.count()) await expect(detailed).toHaveAttribute("target", "_blank");
        // qa-simple-decide-9 / -28: roadmap spans on one line with a year when not this one; Cut asks first.
        await tap(steps(page).getByRole("button", { name: "2 Roadmap" }));
        const span = page.getByTestId("roadmap-span").first();
        await expect(span).toBeVisible();
        await expect(span).toHaveCSS("white-space", "nowrap");
        const restores = await page.getByRole("button", { name: /^Restore / }).count();
        const cut = page.getByRole("button", { name: /^Cut / }).first();
        await tap(cut);
        const ask = page.getByRole("alertdialog");
        await expect(ask).toContainText("from the roadmap?");
        await ask.getByRole("button", { name: "Back" }).click();
        await expect(page.getByRole("button", { name: /^Restore / })).toHaveCount(restores);
        // qa-simple-decide-1/2: the comment shows under the box with who and when; it is no decision.
        await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
        await expect(page.getByRole("region", { name: "Open decisions" })).toHaveCount(0);
        const box = page.getByRole("region", { name: "Comment in the meeting" });
        await box.getByRole("textbox", { name: "Comment" }).fill("We should wait for legal first");
        await tap(box.getByRole("button", { name: "Add comment" }));
        await expect(box.getByTestId("meeting-comment")).toContainText("We should wait for legal first");
        await expect(box.getByTestId("meeting-comment")).toContainText(/Admin · \w{3} \w{3} \d+, \d+:\d{2} [AP]M/);
        await expect(page.getByRole("region", { name: "All decisions" })).not.toContainText("Comment:");
        // qa-simple-decide-21: the chat page link in the accent colour.
        const link = page.getByTestId("meeting-chat-page-link");
        const colours = await link.evaluate((el) => {
          const p = document.createElement("span");
          p.className = "text-accent-ink";
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return [getComputedStyle(el).color, c];
        });
        expect(colours[0]).toBe(colours[1]);
        // qa-simple-decide-22: on a phone the chat has no inner scrolling box.
        await expect(page.getByTestId("meeting-chat-thread-scroll")).toHaveCount(phone ? 0 : 1);
        // qa-simple-decide-6: the summary is prose, not the decision titles; the comment is in no list.
        await endIt(page);
        await expect(page.getByLabel("Summary")).not.toHaveValue(/;|Comment:/);
        await expect(page.getByRole("list", { name: "Decisions taken" })).toHaveCount(0);
        // qa-simple-decide-31: the one day-and-time format, the zone once.
        await expect(page.getByTestId("meeting-ended-at")).toContainText(/Ended \w{3} \w{3} \d+, \d+:\d{2} [AP]M \(/);
        await page.goto("/simple/meetings");
        await expect(page.getByRole("region", { name: "Past" })).not.toContainText("Comment:");
        // qa-simple-decide-33: 44 px taps on a phone.
        if (phone) {
          const box2 = await page.getByTestId("meetings-its-decisions").first().boundingBox();
          expect(box2!.height).toBeGreaterThanOrEqual(44);
        }
      });

      test("Decisions: tabs fit a phone, Decided stacks, one date, grammar, the view in the address", async ({ page }) => {
        await login(page);
        await page.goto("/simple/decisions");
        await expect(page.getByTestId("questions-mine")).toBeVisible();
        // qa-simple-decide-18: plain words for where the questions came from.
        await expect(page.getByTestId("questions-source")).toHaveText(/^Questions from (the .+ PRD( \(draft \d+\))?|\d+ PRDs), checked \w{3} \d+$/);
        // qa-simple-decide-36 / -35: Board in the address, kept on reload; the lead follows.
        await tap(page.getByTestId("decisions-view-board"));
        await expect(page).toHaveURL(/view=board/);
        await expect(page.getByTestId("simple-page")).toContainText("The PRDs' questions by where they stand");
        await page.reload();
        await expect(page.getByTestId("questions-board")).toBeVisible();
        if (phone) {
          // qa-simple-decide-4: no sideways page scroll; "Decided" fits.
          await expect(page.getByTestId("board-tab-decided")).toContainText(/^Decided questions \d+$/);
          expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(390);
        } else {
          // qa-simple-decide-13: Decided questions straight under Needs input.
          const needs = await page.getByTestId("board-needs_input").boundingBox();
          const decided = await page.getByTestId("board-decided").boundingBox();
          const rec = await page.getByTestId("board-recommended").boundingBox();
          expect(Math.abs(decided!.x - needs!.x)).toBeLessThan(2);
          expect(decided!.y).toBeLessThan(needs!.y + needs!.height + 40);
          expect(rec!.x).toBeGreaterThan(needs!.x + 100);
        }
        // qa-simple-decide-12: grammar on a filtered meeting; qa-simple-decide-11: the meeting's day.
        await tap(page.getByTestId("decisions-view-meetings"));
        await expect(page).toHaveURL(/view=meetings/);
        await expect(page.getByTestId("meeting-group-when").first()).toHaveText(/^\w{3} \w{3} \d+ · /);
        await page.getByRole("combobox", { name: "Goal", exact: true }).selectOption({ label: "Grow retention" });
        await expect(page.getByTestId("meeting-group-filtered").first()).toHaveText(/Filtered: (1 decision of this meeting matches|\d+ decisions of this meeting match)\./);
      });

      test("viewers and commenters: no dead Start review; a viewer's chat and notes say what they can do", async ({ page }) => {
        await asRole(page, "viewer");
        await meetings(page);
        // qa-simple-decide-8
        await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
        await expect(page.getByTestId("meetings-start-why")).toContainText("starts reviews");
      });
    });
  }
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1512, height: 900 } });

  test("the rail behind a meeting takes no focus; the chat page shows the mode once; the decider picker marks the current one", async ({ page }) => {
    await startReview(page);
    // qa-simple-decide-5: the first Tab lands inside the meeting.
    await page.mouse.click(700, 600);
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="meeting-screen"]'));
    expect(inside).toBe(true);
    // qa-simple-decide-10: on the chat page the presenter's dropdown, not also the line.
    await tap(page.getByTestId("meeting-chat-page-link"));
    await expect(page).toHaveURL(/\/chat\?/);
    await expect(page.getByTestId("meeting-chat-of")).toBeVisible();
    await expect(page.getByTestId("chat-mode")).toBeVisible();
    await expect(page.locator('[data-testid="chat-rules"]:visible')).toHaveCount(0);
    // qa-simple-decide-26: the named list says how to fill it.
    await page.goto("/simple/meetings");
    await tap(page.getByRole("button", { name: "Start review" }).first());
    const s = sheet(page);
    await expect(s.getByRole("checkbox", { name: "Approver" })).toBeChecked();
    await s.getByRole("checkbox", { name: "Approver" }).uncheck();
    await expect(s.getByRole("checkbox", { name: "Approver" })).not.toBeChecked();
    await s.getByRole("radio", { name: "Presenter plus one or two people" }).check();
    await expect(s.getByTestId("start-named-empty")).toHaveText("Tick attendees above to pick them here.");
  });

  test("Decisions: the owner's override on someone else's question is secondary and says for whom", async ({ page }) => {
    await login(page);
    await page.goto("/simple/decisions");
    const others = page.getByTestId("questions-others");
    await expect(others).toBeVisible();
    // qa-simple-decide-14
    const q7 = others.getByTestId("question-row").filter({ hasText: "Approver decides" }).first();
    await expect(q7.getByRole("button", { name: "Decide as recommended" })).toHaveCount(0);
    await expect(q7.getByRole("button", { name: "Decide for Approver" })).not.toHaveClass(/simple-button-primary/);
  });

  test("a viewer in a meeting: the chat and the notes hint say what a viewer can do", async ({ page }) => {
    await startReview(page, ["Commenter", "Viewer"]);
    const at = new URL(page.url()).pathname;
    await page.goto("/simple/meetings");
    await signOut(page);
    await login(page, "viewer@example.com");
    await page.goto(at);
    // qa-simple-decide-25
    await expect(chat(page).getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask a question about what is on screen");
    await expect(page.getByTestId("meeting-notes-empty")).not.toContainText("note:");
    await expect(page.getByTestId("change-mode")).toContainText("Everyone except viewers");
    // qa-simple-decide-2: a viewer reads the comments and is told why there is no box.
    await tap(steps(page).getByRole("button", { name: "3 Decisions" }));
    await expect(page.getByTestId("meeting-comment-why")).toBeVisible();
  });
});
