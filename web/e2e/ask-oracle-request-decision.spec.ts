import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { SLACK_SCENARIO } from "../lib/api/mock/slack";
import { ADMIN } from "./helpers";

/*
 * ask-oracle-actions: Ask Oracle requests a decision as the person (POST /v1/decisions,
 * "Request a decision"). The card names, before Apply, the person the request pings by Slack,
 * and says it cannot be undone; Apply makes an open decision for that person, which the
 * Decisions page lists with them as its approver. The owner asks (invented mock people: Avery
 * Stone asks Priya Raman; on Ask an action of the API applies for an owner, others propose it,
 * as chat._decides). Desktop (1366x820).
 */

const APPROVER = "Priya Raman";
const TITLE = "whether to ship the weekly digest";
// The mock's company has no Slack connected: the card says so, truthfully (chat-latest-card fix round 2).
const SUMMARY = `Request a decision: title “${TITLE}”, approver “${APPROVER}”. ${APPROVER} sees it in their Inbox; Slack is not connected. This cannot be undone.`;
const SLACK_SUMMARY = `Request a decision: title “${TITLE}”, approver “${APPROVER}”. ${APPROVER} gets a Slack message asking for a decision and sees it in their Inbox. This cannot be undone.`;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function signIn(page: Page, to: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await tap(page.getByRole("button", { name: "Sign in" }));
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(to);
}

async function say(box: Locator, text: string) {
  await box.getByRole("textbox", { name: "Message Oracle" }).fill(text);
  await tap(box.getByRole("button", { name: "Send" }));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 820 });
});

/**
 * Card ask-actions-request-decision: protects = "ask <person> to decide <title>" in the Ask
 * Oracle panel is one card naming the person it asks and truly whether Slack messages them
 * ("Priya Raman sees it in their Inbox; Slack is not connected"), with no Undo once applied, and Apply puts the request on the
 * Decisions page with Priya Raman as its approver, waiting for a decider; a person the company
 * does not have gets no card; fails_when = no card, a card that does not name who is pinged,
 * an Undo on the applied card, or the request missing from the Decisions page; no_claim = the
 * Slack message itself (the API's test_ask_oracle_actions.py).
 */
test("the owner asks Oracle to request a decision, and it waits on the Decisions page", async ({ page }) => {
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await expect(ask).toBeVisible();

  await say(ask, "ask Robin Nobody to decide whether to rename the digest");
  await expect(ask.getByTestId("chat-message").last()).toContainText("I can't tell which record that changes, so I made no card.");
  await expect(ask.getByTestId("chat-card")).toHaveCount(0);

  await say(ask, `ask ${APPROVER} to decide ${TITLE}`);
  const card = ask.getByTestId("chat-message").last().getByTestId("chat-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("chat-card-summary")).toHaveText(SUMMARY);
  await tap(card.getByRole("button", { name: "Apply", exact: true }));
  await expect(card).toHaveAttribute("data-status", "applied");
  await expect(card.getByTestId("chat-card-outcome")).toContainText("Applied by you");
  await expect(card.getByRole("button", { name: "Undo" })).toHaveCount(0);

  await page.goto("/simple/decisions");
  const row = page.getByRole("region", { name: "Outside meetings" }).getByTestId("decision-row").filter({ hasText: TITLE });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(APPROVER);
  await expect(row).toContainText(`${APPROVER} decides`);
});

/**
 * Card ask-actions-slack-truthful (chat-latest-card fix round 2, from PR 1229's review):
 * protects = with the company's Slack connected (the "slack-bridge" scenario) and Priya's
 * review pings on, the card says she gets a Slack message and sees it in her Inbox; without
 * Slack (the test above) it says Slack is not connected; fails_when = a card promises a Slack
 * message Slack will not send, or hides one it will.
 */
test("with Slack connected the request card says Slack messages the approver", async ({ page }) => {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, SLACK_SCENARIO]);
  await signIn(page, "/simple/roadmap");
  await tap(page.getByTestId("simple-ask").filter({ visible: true }).first());
  const ask = page.getByTestId("ask-chat").filter({ visible: true });
  await say(ask, `ask ${APPROVER} to decide ${TITLE}`);
  const card = ask.getByTestId("chat-message").last().getByTestId("chat-card");
  await expect(card.getByTestId("chat-card-summary")).toHaveText(SLACK_SUMMARY);
});
