import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * QA pass 2, simple-decide lane: Meetings, the start sheet, one live meeting, its end screen
 * and the meeting chat's own page, driven through the UI on the mock's invented data.
 *
 * protects = qa-simple-decide-1 (End asks first), -2 (Approve says what it approves, none when
 * nothing), -3 (the chat does not offer questions it refuses), -4 (open questions once, no
 * prefix), -5 (a dark scrim), -6 (the review's own length), -7 (one "who changes things"
 * control, one wording), -11 (the chat page is linked and names its meeting), -12 (the chat
 * scrolls in its card), -13 (Propose all), -14 (a viewer sees no End, no rules control, no
 * Start), -16 (focus stays in the sheet), -17 (readable roadmap dates), -18 (a proposal names
 * its item), -34 (one verb, a live review listed once), -35 (an attendee is required), -36
 * (the series note), -37 (the pre-read link), -38 (the lead, a compact empty Live), -41
 * (away, not struck through), -43 (the notes hint says Apply), -44 (the chosen answer), -45
 * (Cut and Restore), -46 (the minutes editor's feedback), -47 (delivery words, Connect Slack),
 * -49 (one main landmark), -50 (a decision's day), -51 (a neutral Meetings count), -52 (the
 * finished meeting's links).
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

/** The owner starts a review of Guided setup with Commenter too; the live meeting screen. */
async function startReview(page: Page) {
  await meetings(page);
  await tap(page.getByRole("button", { name: "Start review" }).first());
  const s = sheet(page);
  await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
  await s.getByRole("checkbox", { name: "Commenter" }).check();
  await tap(s.getByRole("button", { name: "Start", exact: true }));
  await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
}

async function say(page: Page, text: string) {
  const box = chat(page);
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
  await expect(box.getByTestId("chat-message-body").filter({ hasText: text }).last()).toBeVisible();
}

async function endIt(page: Page) {
  await tap(page.getByRole("button", { name: "End meeting" }));
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("End the review for everyone? Oracle then drafts the minutes");
  await ask.getByRole("button", { name: "End meeting" }).click();
  await expect(page.getByTestId("end-screen")).toBeVisible();
}

const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/;

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${phone ? "phone" : "desktop"} · ${scheme}`, () => {
      test.use({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: scheme });

      test("Meetings: a lead, one verb, a dark scrim, focus kept in the sheet, the review's own length and an attendee required", async ({ page }) => {
        await meetings(page);
        await expect(page.getByTestId("simple-page")).toContainText("Start a review of a PRD, join the one that is on, and read past minutes.");
        await expect(page.getByTestId("meetings-live-empty")).toHaveText("No meeting is on now.");
        await expect(page.getByTestId("meetings-live-empty")).not.toHaveClass(/simple-card/);
        await expect(page.getByRole("button", { name: "Start a review" })).toHaveCount(0);
        // Each upcoming row leads to its pre-read and agenda, or says it is not ready.
        for (const row of await page.getByTestId("meetings-upcoming-row").all()) await expect(row).toContainText(/Pre-read and agenda|Pre-read not ready yet/);
        await expect(page.getByRole("region", { name: "Upcoming" })).not.toContainText(/ P[SD]T\b/);
        if (!phone) await expect(page.getByTestId("simple-nav-meetings-count")).toHaveClass(/simple-count-quiet/);

        await tap(page.getByRole("button", { name: "Start review" }).first());
        const s = sheet(page);
        await expect(s).toBeVisible();
        const bg = await page.getByTestId("start-backdrop").evaluate((el) => getComputedStyle(el).backgroundColor);
        // The design system's scrim (the ds Dialog's), dark in both themes.
        const token = await page.evaluate(() => {
          const el = document.createElement("div");
          el.className = "bg-hero/50";
          document.body.append(el);
          const c = getComputedStyle(el).backgroundColor;
          el.remove();
          return c;
        });
        expect(bg).toBe(token);
        const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
        expect(await inside()).toBe(true);
        for (let i = 0; i < 25; i++) {
          await page.keyboard.press("Tab");
          expect(await inside()).toBe(true);
        }
        await expect(s.getByRole("radio", { name: "Presenter plus one or two people" })).toBeVisible();
        await s.getByLabel("PRD").selectOption({ label: "Guided setup" });
        for (const box of await s.getByRole("group", { name: "Who attends" }).getByRole("checkbox").all()) await box.uncheck();
        await expect(s.getByTestId("start-no-attendees")).toHaveText("Pick at least one attendee besides you.");
        await expect(s.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(s).toBeHidden();

        const weekly = page.getByTestId("meetings-upcoming-row").filter({ hasText: "Weekly goals check-in" }).first();
        await expect(weekly).toContainText("30 min");
        await tap(weekly.getByRole("button", { name: "Start review" }));
        await expect(s.getByLabel("Length")).toHaveValue("30");
        await expect(s).toContainText("also attend the next reviews of Weekly goals check-in");
      });

      test("a viewer gets no Start review, no End meeting and no rules control", async ({ page }) => {
        await startReview(page);
        const url = page.url();
        await asRole(page, "viewer");
        await page.goto(url);
        await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
        await expect(page.getByRole("timer", { name: "Meeting clock" })).toBeVisible();
        await expect(page.getByRole("button", { name: "End meeting" })).toHaveCount(0);
        await expect(page.getByRole("combobox", { name: "Who changes things" })).toHaveCount(0);
        await expect(chat(page).getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask a question about what is on screen");
        await page.goto("/simple/meetings");
        await expect(page.getByRole("region", { name: "Upcoming" }).getByRole("button", { name: "Start review" })).toHaveCount(0);
        // The live review is listed under Live only.
        await expect(page.getByRole("region", { name: "Live" })).toContainText("Review: Guided setup");
        await expect(page.getByRole("region", { name: "Upcoming" }).getByRole("link", { name: "Open" })).toHaveCount(0);
        // qa-simple-decide-8: no Start review that ends in "Only Admin can start"; the reason stands in its place.
        await expect(page.getByRole("button", { name: "Start review" })).toHaveCount(0);
        await expect(page.getByTestId("meetings-start-why")).toBeVisible();
      });
    });
  }
}

test.describe("desktop · the live meeting", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one main, one rules control, no Approve with nothing to approve, a scrolling chat linked to its own page; End asks first", async ({ page }) => {
    await startReview(page);
    await expect(page.locator("main main")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Stage" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Approve( one-pager|$)/ })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Who changes things" })).toHaveCount(1);
    await expect(chat(page)).not.toContainText("Change who may apply");
    await expect(chat(page).getByTestId("chat-rules")).toContainText("Who changes things: Everyone");
    await expect(chat(page).getByRole("textbox", { name: "Message Oracle" })).toHaveAttribute("placeholder", "Ask for a change, or type “note: …”");
    await expect(page.getByTestId("meeting-notes")).toContainText("then press Apply");
    // A question is kept for the minutes and pointed to Ask Oracle, not refused.
    await say(page, "what is blocking M1?");
    await expect(chat(page).locator('[data-testid="chat-message"][data-kind="note"]').last()).toContainText("use Ask Oracle");
    for (let i = 1; i <= 6; i++) await say(page, `note: point ${i}`);
    const scroll = chat(page).getByTestId("meeting-chat-thread-scroll");
    expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(chat(page).getByRole("textbox", { name: "Message Oracle" })).toBeInViewport();

    // Absent: "away" with a grey dot, never struck through.
    await page.getByRole("button", { name: "Approver is here" }).click();
    const away = page.getByLabel("Attendees").locator("li", { hasText: "Approver" });
    await expect(away.getByTestId("attendee-away")).toBeVisible();
    expect(await away.evaluate((el) => getComputedStyle(el).textDecorationLine)).not.toContain("line-through");

    // Roadmap: readable days, a Cut button and Restore on what was cut.
    await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
    const slice = page.getByRole("region", { name: "Roadmap slice" });
    await expect(slice.locator("li").first()).toBeVisible();
    await expect(slice).not.toContainText(ISO_DAY);
    const first = slice.locator("li").first();
    const title = (await first.locator("strong").innerText()).trim();
    await first.getByRole("button", { name: `Cut ${title}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cut", exact: true }).click();
    await expect(slice.getByRole("button", { name: `Restore ${title}` })).toBeVisible();
    await expect(page.getByRole("region", { name: "All decisions" }).getByTestId("meeting-decision").first()).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}/);

    // The chat's own page: linked here, it names the meeting and leads back.
    await page.getByTestId("meeting-chat-page-link").click();
    await expect(page.getByTestId("meeting-chat-of")).toContainText("The chat of Review: Guided setup");
    await expect(page.getByText("Meeting chat", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await page.getByRole("link", { name: "Back to the meeting" }).click();
    await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();

    // End asks first; Back keeps the meeting on.
    await page.getByRole("button", { name: "End meeting" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("timer", { name: "Meeting clock" })).toBeVisible();
    await endIt(page);
  });

  test("Decisions step: the chosen answer is shown; open questions appear once, without the prefix; the minutes editor answers", async ({ page }) => {
    await startReview(page);
    await steps(page).getByRole("button", { name: "3 Decisions" }).click();
    const agenda = page.getByTestId("decisions-due");
    const row = agenda.getByTestId("question-row").filter({ has: page.getByRole("button", { name: "Decide as recommended" }) }).first();
    const rec = (await row.locator(".simple-rec").innerText()).replace(/^PRD recommends\s*/, "").trim();
    await row.getByRole("button", { name: "Decide as recommended" }).click();
    await expect(agenda.getByTestId("question-decided").filter({ hasText: `Decided in this meeting: ${rec}` })).toBeVisible();

    await say(page, "open question: do we need SSO for teams over 50?");
    await tap(chat(page).getByTestId("chat-card").last().getByRole("button", { name: "Apply" }));
    await expect(page.getByTestId("meeting-note")).toContainText("do we need SSO for teams over 50?");
    await endIt(page);
    const minutes = page.getByRole("region", { name: "Minutes" });
    const questions = await minutes.getByLabel("Open questions").inputValue();
    expect(questions.match(/SSO/g)?.length).toBe(1);
    expect(questions).not.toMatch(/open question:/i);
    await expect(minutes.getByLabel("Summary")).not.toHaveValue(/decisions? in Review/);

    // The minutes editor: a clear Save, an error for an empty item, a remove button, a toast.
    await minutes.getByRole("button", { name: "Add action item" }).click();
    await expect(minutes.getByLabel("Action item 1", { exact: true })).toHaveAttribute("placeholder", "What needs doing");
    await minutes.getByRole("button", { name: "Save minutes" }).click();
    await expect(minutes.getByRole("alert")).toHaveText("Type what the action item is, or remove it.");
    await minutes.getByRole("button", { name: "Remove action item 1" }).click();
    await expect(minutes.getByTestId("action-item")).toHaveCount(0);
    await minutes.getByRole("button", { name: "Add action item" }).click();
    await minutes.getByLabel("Action item 1", { exact: true }).fill("Write the SSO note");
    await minutes.getByLabel("Due date of action item 1").fill("2026-11-05");
    await minutes.getByRole("button", { name: "Save minutes" }).click();
    await expect(page.getByText("Minutes saved")).toBeVisible();
    await expect(minutes).toContainText("All changes saved");
    // Delivery in plain words, with a way to connect Slack; the meeting's links.
    const delivery = page.getByRole("region", { name: "Delivery" });
    await expect(delivery.getByRole("link", { name: /Connect Slack|Pick a channel/ })).toBeVisible();
    await expect(delivery).not.toContainText("Not connected");
    // fix2-simple-decide review: no "From the meeting" section nobody asked for.
    await expect(page.getByRole("region", { name: "From the meeting" })).toHaveCount(0);
    await delivery.getByRole("button", { name: "Send" }).click();
    await expect(delivery.getByRole("status", { name: "Sent" })).toBeVisible();
    await expect(delivery).not.toContainText("not chosen");
    await expect(minutes).toContainText("by Thu Nov 5");
    await expect(minutes).not.toContainText(ISO_DAY);
    await expect(minutes.getByRole("link", { name: /SSO/ })).toHaveAttribute("href", /\/simple\/decisions\?meeting=/);
  });

  test("as a commenter: Propose all, and a proposal names its item", async ({ page }) => {
    // Only an owner starts a review; the commenter then joins it (the mock keeps its data on reload).
    await startReview(page);
    const url = page.url();
    await page.evaluate(([key, r]) => localStorage.setItem(key, r), [MOCK_ROLE_KEY, "commenter"] as const);
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();
    await steps(page).getByRole("button", { name: "2 Roadmap" }).click();
    const slice = page.getByRole("region", { name: "Roadmap slice" });
    const item = slice.locator("li").filter({ has: page.getByRole("button", { name: /^Move .* to Now$/ }) }).first();
    const title = (await item.locator("strong").innerText()).trim();
    await item.getByRole("button", { name: `Move ${title} to Now` }).click();
    await expect(slice.getByRole("status")).toContainText("Proposed");
    await steps(page).getByRole("button", { name: "3 Decisions" }).click();
    await expect(page.getByRole("region", { name: "Pending proposals" })).toContainText(`proposes: move ${title} to Now`);

    await say(page, "push Welcome video to next quarter and cut Sample data import");
    await expect(chat(page).getByRole("button", { name: "Propose all" })).toBeVisible();
    await expect(chat(page).getByRole("button", { name: "Apply all" })).toHaveCount(0);
  });
});
