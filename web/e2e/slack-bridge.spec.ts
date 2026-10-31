import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { MIRRORED_TITLE, SLACK_SCENARIO } from "../lib/api/mock/slack";
import { login, openTab } from "./helpers";

/*
 * G8 Slack bridge through the UI, on the mock layer (lib/api/mock/slack.ts): Slack itself is
 * never called. The "slack-bridge" scenario seeds Oracle's Slack install ("Example Co", with
 * the bridge's scopes), the "discussion-replies" discussions on team-workspaces v2's Problem
 * (the commenter's private one with the approver, and the commenter's open "Caps: ship
 * without detection?"), and the approver's open discussion mirrored to #product. The default
 * scenario has no install.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>. The API's rules (signatures, roles from Slack, the outbox) are
 * covered by the API tests.
 */

const SEEDED = "/documents/team-workspaces/v/2";
const PRIVATE_TITLE = "Problem: who owns the admin role?";
const OPEN_TITLE = "Caps: ship without detection?";
const COMMENTER = "commenter@example.com";
const APPROVER = "approver@example.com";

const withScenario = (page: Page) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, SLACK_SCENARIO]);
const panel = (page: Page) => page.getByRole("complementary", { name: "Review panel" }).filter({ visible: true });
const thread = (page: Page) => page.getByTestId("discussion-thread").filter({ visible: true });

async function openDiscussion(page: Page, title: string) {
  await page.goto(SEEDED);
  await openTab(page, "Feedback");
  await panel(page).getByTestId("feedback-discussions").click();
  await panel(page).getByTestId("discussion-row").filter({ hasText: title }).first().click();
  await expect(thread(page)).toBeVisible();
  await expect(thread(page).getByRole("heading", { name: title })).toBeVisible();
}

async function openMenu(page: Page) {
  await thread(page).getByRole("button", { name: "Discussion actions" }).click();
}

// protects=criterion 12.1: an owner connects Oracle to Slack from the Slack card, and the card
// then names the Slack and says discussions can be mirrored; fails_when="Connect Oracle to
// Slack" is missing, or after the install the card does not read "Connected to … as @Product
// Oracle" with "People can mirror discussions to a Slack thread."; no_claim=Slack's OAuth
// screen (the mock install returns at once) or the scopes Slack grants.
test("an owner connects Oracle to Slack and the card says discussions can be mirrored", async ({ page }) => {
  await login(page);
  await page.goto("/settings");
  await page.getByTestId("settings-nav").getByRole("link", { name: "Notifications" }).click();
  const card = page.getByTestId("slack-notifications");
  await card.getByRole("button", { name: "Connect Oracle to Slack" }).click();
  await expect(page.getByText("Slack is connected for notifications.")).toBeVisible();
  await expect(card.getByTestId("slack-connected")).toHaveText(/^Connected to .+ as @Product Oracle$/);
  await expect(card.getByTestId("slack-connected")).toHaveText("Connected to Example Co as @Product Oracle");
  await expect(card).toContainText("People can mirror discussions to a Slack thread.");
  await expect(card.getByTestId("slack-reconnect")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Connect Oracle to Slack" })).toHaveCount(0);
});

// protects=criterion 12.2: the starter (a commenter) mirrors an open discussion to #product
// from its ⋯ menu, through a searchable channel picker and the confirm copy, and the header
// then shows the "#product" chip linking to the thread; fails_when="Mirror to Slack…" is
// missing for the starter, the picker hint or confirm copy is wrong, or no chip shows after
// Mirror; review #491 item 1: the picker offers only channels Oracle's app is in (#general,
// public but without the app, is absent); no_claim=the root message Oracle posts in Slack
// (the outbox, API tests).
test("the starter mirrors an open discussion to #product: confirm copy, then the #product chip", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page, OPEN_TITLE);
  await expect(thread(page).getByTestId("discussion-slack")).toHaveCount(0);
  await openMenu(page);
  await thread(page).getByRole("menuitem", { name: "Mirror to Slack…" }).click();

  const dialog = page.getByRole("dialog", { name: "Mirror to Slack" });
  await expect(dialog).toContainText("Invite @Product Oracle to a channel to see it here.");
  const options = dialog.getByRole("listbox", { name: "Channels" }).getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options.filter({ hasText: "#product" })).toHaveCount(1);
  // #general is a public channel Oracle's app is not in: its replies would never come back.
  await expect(options.filter({ hasText: "#general" })).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "Find a channel" }).fill("prod");
  await expect(options).toHaveCount(1);
  await options.filter({ hasText: "#product" }).click();
  await expect(dialog.getByTestId("mirror-confirm")).toHaveText(
    "Everything posted in this discussion from now on, Oracle's replies included, will be visible to everyone in #product, including people who are not in Oracle.",
  );
  await dialog.getByRole("button", { name: "Mirror to #product" }).click();
  await expect(dialog).toHaveCount(0);

  const chip = thread(page).getByTestId("discussion-slack");
  await expect(chip).toHaveText("#product");
  await expect(chip).toHaveAttribute("href", /^https:\/\/example-co\.slack\.com\/archives\/C0PRODUCT\//);
  await openMenu(page);
  await expect(thread(page).getByRole("menuitem", { name: "Stop mirroring" })).toBeVisible();
  await expect(thread(page).getByRole("menuitem", { name: "Mirror to Slack…" })).toHaveCount(0);
});

// protects=criterion 12.3: a private discussion is never offered to Slack (the item is absent,
// with the info tip "Private discussions stay in Oracle"), and once its starter makes it open
// after G1's warning, "Mirror to Slack…" appears; fails_when=a private discussion's menu
// offers Mirror to Slack, the tip is missing, or the item stays absent once it is open;
// no_claim=the API's 422 on a private discussion (API tests).
test("a private discussion has no Mirror to Slack until its starter makes it open", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await openDiscussion(page, PRIVATE_TITLE);
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Private");
  await openMenu(page);
  await expect(thread(page).getByRole("menuitem", { name: "Make open" })).toBeVisible();
  await expect(thread(page).getByRole("menuitem", { name: /Mirror to Slack/ })).toHaveCount(0);
  const tip = thread(page).getByTestId("slack-private-tip");
  await tip.getByRole("button", { name: "About Slack" }).click();
  await expect(tip.getByRole("tooltip")).toHaveText("Private discussions stay in Oracle");

  await thread(page).getByRole("menuitem", { name: "Make open" }).click();
  const warning = page.getByTestId("make-open-warning");
  await expect(warning).toContainText("Make this discussion open?");
  await warning.getByRole("button", { name: "Make open" }).click();
  await expect(warning).toHaveCount(0);
  await expect(thread(page).getByTestId("discussion-visibility")).toHaveText("Open");

  await openMenu(page);
  await expect(thread(page).getByRole("menuitem", { name: "Mirror to Slack…" })).toBeVisible();
  await expect(thread(page).getByTestId("slack-private-tip")).toHaveCount(0);
});

// protects=criterion 12.4: a reply written in the mirrored Slack thread shows in the
// discussion, attributed to the member, with a small "via Slack" label; fails_when=the reply
// is missing or carries no "via Slack" label, or a message written in Oracle carries it;
// no_claim=the signed events endpoint or the email lookup that maps the Slack user (API
// tests; the mock hook stores the reply as the endpoint would).
test("a reply from the mirrored Slack thread appears with via Slack", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page, MIRRORED_TITLE);
  await expect(thread(page).getByTestId("discussion-slack")).toHaveText("#product");

  // The documented mock hook: Slack delivers the commenter's reply in the thread.
  await page.evaluate(
    ([title, email]) =>
      (globalThis as unknown as { __poMockSlack: { reply: (x: { title: string; email: string; text: string }) => Promise<string> } }).__poMockSlack.reply({
        title,
        email,
        text: "Weekly. Daily digests would be noise for most teams.",
      }),
    [MIRRORED_TITLE, COMMENTER],
  );

  await openDiscussion(page, MIRRORED_TITLE);
  const fromSlack = thread(page).getByTestId("discussion-message").filter({ hasText: "Weekly. Daily digests would be noise for most teams." });
  await expect(fromSlack).toHaveCount(1);
  await expect(fromSlack).toContainText("Theo Brandt");
  await expect(fromSlack.getByTestId("via-slack")).toHaveText("via Slack");
  const fromOracle = thread(page).getByTestId("discussion-message").filter({ hasText: "Daily digests or weekly?" });
  await expect(fromOracle.getByTestId("via-slack")).toHaveCount(0);
});

// protects=review #431 item 1: when Slack gives up on a mirror's first post (here the app was
// removed from the channel), the starter sees why on the discussion, the chip no longer links
// to a thread, and Stop mirroring frees the discussion to be mirrored again; fails_when=the
// reason is missing, the chip still links, or the discussion stays stuck as mirrored;
// no_claim=the outbox's retries and the other mirrors still flowing (API tests).
test("a mirror whose first post failed shows Slack's reason, and Stop mirroring frees it", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page, MIRRORED_TITLE);
  await expect(thread(page).getByTestId("slack-failed")).toHaveCount(0);

  // The documented mock hook: Slack refused the thread's first post until the outbox gave up.
  await page.evaluate(
    ([title]) =>
      (globalThis as unknown as { __poMockSlack: { fail: (x: { title: string; error: string }) => Promise<void> } }).__poMockSlack.fail({
        title,
        error: "not_in_channel",
      }),
    [MIRRORED_TITLE],
  );

  await openDiscussion(page, MIRRORED_TITLE);
  await expect(thread(page).getByTestId("slack-failed")).toHaveText("Slack mirror failed: not_in_channel. Stop mirroring to mirror it again.");
  const chip = thread(page).getByTestId("discussion-slack");
  await expect(chip).toHaveText("#product");
  await expect(chip).not.toHaveAttribute("href", /.*/);
  await openMenu(page);
  await thread(page).getByRole("menuitem", { name: "Stop mirroring" }).click();
  const ask = page.getByRole("alertdialog", { name: "Stop mirroring" });
  await expect(ask).toContainText("Stop mirroring to #product? Nothing was posted in Slack.");
  await ask.getByRole("button", { name: "Stop mirroring" }).click();
  await expect(chip).toHaveCount(0);
  await expect(thread(page).getByTestId("slack-failed")).toHaveCount(0);
  await openMenu(page);
  await expect(thread(page).getByRole("menuitem", { name: "Mirror to Slack…" })).toBeVisible();
});

// protects=review #451 item 1: stopping a mirror whose first post Slack has not taken yet
// says nothing was posted in Slack (no closing line goes to a thread that never existed), and
// frees the discussion to be mirrored again; fails_when=the confirm promises a closing line in
// the thread, or the discussion stays mirrored; no_claim=the outbox dropping the queued root
// and later mirrors still posting (API tests).
test("stopping a mirror before its first post says nothing was posted in Slack", async ({ page }) => {
  await withScenario(page);
  await login(page, APPROVER);
  await openDiscussion(page, MIRRORED_TITLE);

  // The documented mock hook: the outbox still holds the thread's first post.
  await page.evaluate(
    ([title]) => (globalThis as unknown as { __poMockSlack: { posting: (x: { title: string }) => Promise<void> } }).__poMockSlack.posting({ title }),
    [MIRRORED_TITLE],
  );

  await openDiscussion(page, MIRRORED_TITLE);
  const chip = thread(page).getByTestId("discussion-slack");
  await expect(chip).toHaveText("#product");
  await expect(chip).not.toHaveAttribute("href", /.*/);
  await openMenu(page);
  await thread(page).getByRole("menuitem", { name: "Stop mirroring" }).click();
  const ask = page.getByRole("alertdialog", { name: "Stop mirroring" });
  await expect(ask).toContainText("Stop mirroring to #product? Nothing was posted in Slack.");
  await expect(ask).not.toContainText("closing line");
  await ask.getByRole("button", { name: "Stop mirroring" }).click();
  await expect(chip).toHaveCount(0);
  await openMenu(page);
  await expect(thread(page).getByRole("menuitem", { name: "Mirror to Slack…" })).toBeVisible();
});

// protects=a G7 panel chat is never offered to Slack (no Mirror item, no private tip) until it
// is shared as a discussion, whose ⋯ then offers Mirror to Slack…; fails_when=the panel chat's
// ⋯ shows Mirror to Slack or the private-discussion tip, or the shared one cannot be mirrored;
// no_claim=the API's refusal (API tests).
test("a panel chat is not mirrored until it is shared as a discussion", async ({ page }) => {
  await withScenario(page);
  await login(page, COMMENTER);
  await page.goto(SEEDED);
  await page.getByTestId("hop-strip").click();
  const hop = page.getByTestId("hop-panel").filter({ visible: true });
  await hop.getByRole("textbox", { name: "Ask Oracle" }).fill("Is caps one sprint?");
  await hop.getByRole("button", { name: "Send" }).click();
  const chat = hop.getByTestId("discussion-thread");
  await expect(chat.getByTestId("discussion-visibility")).toHaveText("Private");
  await expect(chat.getByTestId("oracle-reply").last()).toContainText(/\w/);
  await chat.getByRole("button", { name: "Discussion actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Write summary" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Mirror to Slack/ })).toHaveCount(0);
  await expect(page.getByTestId("slack-private-tip")).toHaveCount(0);
  await chat.getByRole("button", { name: "Discussion actions" }).click();

  await hop.getByRole("button", { name: "Share as discussion" }).click();
  const form = hop.getByTestId("hop-share-form");
  await form.getByRole("textbox", { name: "First message" }).fill("Caps in one sprint, detection after.");
  await form.getByRole("button", { name: "Post" }).click();
  await expect(hop.getByTestId("hop-shared")).toBeVisible();
  const shared = hop.getByTestId("discussion-thread");
  await expect(shared.getByTestId("discussion-visibility")).toHaveText("Open");
  await shared.getByRole("button", { name: "Discussion actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Mirror to Slack…" })).toBeVisible();
});
