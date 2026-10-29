import { expect, test, type Page } from "./test";

import { login, openSection, sectionAction } from "./helpers";

/*
 * Live Ask (#710, lane 3) through the UI, on the mock layer: Oracle reads the asker's own
 * Fireflies connection at the moment they ask, in a private Ask chat only. The mock's
 * Fireflies connection answers a total of 4,321 meetings and one invented meeting,
 * FF-2041 "Pricing review with the design team"; its reply cites each read as [l:1],
 * drawn as a chip "<source> · <call> · read <time>" in the Company time zone, with no link.
 *
 * Cards:
 * Count and pull: protects=AC 1, 2 and 9, a private Ask chat answers the connection's
 * total and one meeting with a live chip per read, and the composer names what Oracle may
 * read live; fails_when=the count, the title or the chip is missing, the chip is a link or
 * its time is not in the Company time zone, or the composer's line is missing;
 * no_claim=the real API's reads, budgets and tokens (api/tests/test_live_*.py) or the real
 * model citing them (CLD's production walk, AC 10).
 * Others in the chat: protects=AC 4's panel line, "Live reads are off: others can read
 * this discussion.", in a two-person chat, and section 2's 409 live_reads_in_chat shown in
 * place when a person is added to a chat holding live reads; fails_when=the line is
 * missing in the two-person chat or shows in the private one, or adding a person shows no
 * sentence, a browser dialog, or adds them; no_claim=the API's FOR UPDATE race (C3) or the
 * reply run's argv (API tests).
 */

const DOC = "/documents/checkout-redesign/v/2";
const LABEL = "Fireflies Archive";
const MEETING_ID = "FF-2041";
const MEETING_TITLE = "Pricing review with the design team";
const OFF = "Live reads are off: others can read this discussion.";
// MOCK_NOW is 12:00 UTC, 5:00 AM in the Company time zone (America/Los_Angeles, PDT); the clock runs on.
const READ_AT = /read 5:\d\d AM PDT/;

const panel = (page: Page) => page.getByTestId("hop-panel").filter({ visible: true });
const thread = (page: Page) => panel(page).getByTestId("discussion-thread");
const replies = (page: Page) => thread(page).getByTestId("oracle-reply");

/** Connects Fireflies in Settings > Connections with a key and the label "Fireflies Archive". */
async function connectFireflies(page: Page) {
  await page.goto("/settings/connections");
  const card = page.getByTestId("connection-card-fireflies");
  await card.getByRole("button", { name: "Paste a token" }).click();
  await card.getByLabel("Token", { exact: true }).fill("ff-example-key-1234");
  await card.getByLabel("Label (optional)").fill(LABEL);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(card).toContainText(LABEL);
}

/** Opens Ask with ⌘J / Ctrl+J and starts a private chat with `question`. */
async function ask(page: Page, question: string) {
  await expect(page.getByTestId("hop-strip")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("textbox", { name: "Ask Oracle" }).fill(question);
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(thread(page)).toBeVisible();
}

/** Writes `text` in the open thread's composer. */
async function reply(page: Page, text: string) {
  const composer = thread(page).getByTestId("discussion-composer");
  await composer.getByRole("textbox", { name: "Message" }).fill(text);
  await composer.getByRole("button", { name: "Send" }).click();
}

test("Ask reads Fireflies live in a private chat: the count, then one meeting, each with its chip", async ({ page }) => {
  await login(page);
  await connectFireflies(page);
  await page.goto("/home");
  await ask(page, "How many Fireflies meetings can you read?");

  const first = replies(page).first();
  await expect(first).toHaveAttribute("data-status", "complete");
  await expect(first.getByTestId("oracle-reply-text")).toContainText("4,321");
  const chip = first.getByTestId("live-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText(`${LABEL} · list_meetings · `);
  await expect(chip).toHaveText(READ_AT);
  await expect(chip.locator("a")).toHaveCount(0);
  await expect(first.getByTestId("oracle-reply-text")).not.toContainText("[l:1]");
  // Just the asker: the composer names what Oracle may read live, and says nothing is off.
  await expect(thread(page).getByTestId("live-reads-notice")).toContainText(`Oracle may read live: ${LABEL}`);
  await expect(thread(page)).not.toContainText(OFF);

  await reply(page, `Pull meeting ${MEETING_ID}`);
  await expect(replies(page)).toHaveCount(2);
  const second = replies(page).nth(1);
  await expect(second).toHaveAttribute("data-status", "complete");
  await expect(second.getByTestId("oracle-reply-text")).toContainText(MEETING_TITLE);
  await expect(second.getByTestId("oracle-reply-text")).toContainText(MEETING_ID);
  await expect(second.getByTestId("live-chip")).toContainText(`${LABEL} · get_meeting · `);
  await expect(second.getByTestId("live-chip")).toHaveText(READ_AT);
});

test("with others in the chat live reads are off, and a chat holding live reads refuses a new person in place", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await login(page);
  await connectFireflies(page);

  // A private discussion with the approver: two people, so Oracle reads nothing live.
  await page.goto(DOC);
  const s = await openSection(page, "problem");
  await sectionAction(s, "2. Problem", "Discuss this section");
  const form = page.getByTestId("start-discussion").filter({ visible: true });
  await form.getByRole("group", { name: "Visible to" }).getByRole("button", { name: "Only people I pick" }).click();
  await form.getByRole("searchbox", { name: "Find a person" }).fill("approver");
  await form.getByRole("option", { name: /Approver/ }).click();
  await form.getByRole("button", { name: "Start discussion" }).click();
  const shared = page.getByTestId("discussion-thread").filter({ visible: true }).first();
  await expect(shared.getByTestId("discussion-people")).toHaveText("2 people");
  await expect(shared.getByTestId("live-reads-notice")).toHaveText(OFF);

  // A private Ask chat that read Fireflies live: adding a person is refused, its sentence in place.
  await page.goto("/home");
  await ask(page, "How many Fireflies meetings can you read?");
  await expect(replies(page).first()).toHaveAttribute("data-status", "complete");
  await expect(replies(page).first().getByTestId("live-chip")).toHaveCount(1);
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
  await panel(page).getByRole("menuitem", { name: "People" }).click();
  const people = thread(page).getByTestId("discussion-people-list");
  await people.getByRole("searchbox", { name: "Find a person" }).fill("approver");
  await people.getByRole("option", { name: /Approver/ }).click();
  await expect(people.getByRole("alert")).toHaveText(
    "This chat holds what Oracle read from your sources. Use Share as discussion to share an edited summary instead.",
  );
  await expect(thread(page).getByTestId("discussion-people")).toHaveText("1 person");
  await expect(thread(page)).not.toContainText(OFF);
  expect(dialogs).toBe(0);
});
