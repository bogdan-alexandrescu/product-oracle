import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { THEME_KEY } from "../lib/theme";
import { ADMIN, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * Pick D+E (the owner, 2026-10-28): each goal's ONE button "Suggestions · N" (Home's goal cards,
 * Priorities' goal buckets) opens its drawer: the "Suggest a feature" form on top (who decides
 * named), "Suggest from the chat", then the tabs "People · N" and "✦ Oracle · N". Oracle suggests
 * only when asked ("✦ Ask Oracle for more"; the button says "Oracle is suggesting..." until it is
 * done); only the decider sees Accept / Reject, and their form folds to one line. From the chat,
 * "Suggest a feature for <goal>: <words>" is restated with its look-alikes and ONE card; Apply
 * files it as the person's own suggestion (People). Mock data is invented
 * (web/lib/api/mock/simple-suggestions.ts, simple-chat.ts): Grow retention starts with one
 * suggestion Oracle was asked for; the owner decides with no named decider.
 * Desktop 1366x820 and phone 390x844, light and dark.
 */

const EMAILS = { owner: ADMIN.email, commenter: "commenter@example.com", viewer: "viewer@example.com" } as const;

async function signIn(page: Page, email: string, path = "/simple") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(path);
}

const toastWith = (page: Page, text: string | RegExp): Locator => page.getByRole("status").filter({ hasText: text });
const retentionButton = (page: Page) => page.getByRole("button", { name: "Suggestions for Grow retention", exact: true });

async function openDrawer(page: Page): Promise<Locator> {
  await retentionButton(page).click();
  const drawer = page.getByTestId("goal-panel");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closeDrawer(page: Page, phone: boolean) {
  if (phone) await page.keyboard.press("Escape");
  else await page.getByTestId("goal-panel").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("goal-panel")).toHaveCount(0);
}

async function signOutHere(page: Page, phone: boolean) {
  if (!phone) return signOut(page);
  await page.getByTestId("phone-user-menu").click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function noSidewaysScroll(page: Page, phone: boolean) {
  if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"] as const) {
    const where = `${phone ? "phone" : "desktop"}, ${scheme}`;

    test.describe(where, () => {
      test.beforeEach(async ({ page, context }) => {
        await context.addInitScript(
          ([key, themeKey, theme]) => {
            localStorage.setItem(key, "simple-home");
            localStorage.setItem(themeKey, theme);
          },
          [MOCK_SCENARIO_KEY, THEME_KEY, scheme],
        );
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1366, height: 820 });
      });

      /**
       * Card simple-suggest-drawer: protects = a commenter's goal card has ONE "Suggestions · N"
       * button; its drawer has the form (Feature name, What it does and for whom, the goal set,
       * "<decider> will review your suggestion.") and the People / ✦ Oracle tabs; Send suggestion lands under People
       * with who sent it; "✦ Ask Oracle for more" makes the button say "Oracle is suggesting..."
       * and the count changes only once it is done; the commenter sees no Accept / Reject; the
       * owner (the decider) sees the form folded to one line and accepts the person's suggestion;
       * goal targets read in words with their unit; fails_when = the button or tabs are missing,
       * the suggestion is not filed as the person's, the count changes while Oracle suggests,
       * a commenter can accept, the decider's form is not folded, or a target is a bare number;
       * no_claim = the real suggestion job's ideas, the API's role checks (api/tests).
       */
      test(`a commenter suggests from the drawer, asks Oracle for more, the decider accepts (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.commenter);
        const card = page.getByTestId("home-goal").filter({ hasText: "Grow retention" });
        await expect(card.getByTestId("home-goal-path")).toHaveText("From 50 teams · now 100 teams · target 200 teams with weekly alerts on");
        await expect(card.getByTestId("goal-suggestions-open")).toHaveCount(1);
        await expect(retentionButton(page)).toHaveText("Suggestions · 1");

        let drawer = await openDrawer(page);
        const form = drawer.getByTestId("suggest-form");
        await expect(form.getByText("Goal: Grow retention")).toBeVisible();
        await expect(drawer.getByTestId("suggest-decider")).toHaveText(/ will review your suggestion\.$/);
        // QA pass 3 (qa-simple-plan-10): the drawer opens on the tab that holds the suggestions.
        await expect(drawer.getByRole("tab", { name: "✦ Oracle · 1" })).toHaveAttribute("aria-selected", "true");
        await expect(drawer.getByRole("tab", { name: "People · 0" })).toBeVisible();
        await form.getByLabel("Feature name").fill("Shared alert notes");
        await form.getByLabel("What it does, and for whom").fill("Leads leave a note on an alert so the next person on call knows what was tried");
        await form.getByRole("button", { name: "Send suggestion" }).click();
        await expect(toastWith(page, "Sent: Shared alert notes")).toBeVisible();
        await expect(drawer.getByRole("tab", { name: "People · 1" })).toBeVisible();
        const mine = drawer.locator('[data-testid="person-suggestion"][data-title="Shared alert notes"]');
        await expect(mine.getByTestId("suggestion-by")).toContainText("From ");
        await expect(mine.getByRole("button", { name: "Accept" })).toHaveCount(0);

        await drawer.getByRole("tab", { name: "✦ Oracle · 1" }).click();
        const first = drawer.getByTestId("goal-suggestion").first();
        await expect(first.getByTestId("oracle-suggested")).toHaveText("✦ Oracle suggested");
        await expect(first.getByTestId("suggestion-why")).toContainText("Why:");
        await expect(first.getByTestId("suggestion-evidence")).toContainText("Sources:");
        await drawer.getByRole("button", { name: "✦ Ask Oracle for more" }).click();
        await expect(drawer.getByTestId("suggest-pending")).toBeVisible();
        // While Oracle suggests, the count holds and the button says why.
        await expect(retentionButton(page)).toHaveText("Oracle is suggesting...");
        await expect(drawer.getByRole("tab", { name: "✦ Oracle · 4" })).toBeVisible({ timeout: 10_000 });
        await expect(retentionButton(page)).toHaveText("Suggestions · 5");
        await noSidewaysScroll(page, phone);
        await closeDrawer(page, phone);

        await signOutHere(page, phone);
        await signIn(page, EMAILS.owner);
        drawer = await openDrawer(page);
        await expect(drawer.getByTestId("suggest-form")).toHaveCount(0);
        await expect(drawer.getByTestId("suggest-form-open")).toHaveText("+ Suggest a feature");
        const theirs = drawer.locator('[data-testid="person-suggestion"][data-title="Shared alert notes"]');
        await expect(theirs.getByRole("button", { name: "Reject" })).toBeVisible();
        await theirs.getByRole("button", { name: "Accept" }).click();
        await expect(toastWith(page, "Added Shared alert notes as a draft")).toBeVisible();
        await expect(theirs).toHaveCount(0);
        await expect(drawer.getByRole("tab", { name: "People · 0" })).toBeVisible();
      });

      /**
       * Card simple-suggest-chat: protects = "Suggest from the chat" opens Ask Oracle with
       * "Suggest a feature for Grow retention: " typed in; the person finishes it in their words;
       * Oracle restates it, flags the look-alike by its code and name ("It looks like F-06 Weekly
       * alert digest, which …", never the item's key)
       * and shows ONE card with Preview / Apply / Discard; Apply files it as the person's own
       * suggestion, under People in the goal's drawer; fails_when = Ask opens empty, there is no
       * look-alike line, it names the item's key, there is more than one card, or the applied
       * suggestion is not under People;
       * no_claim = Oracle's model reading free words (the fixed phrase is what the mock reads).
       */
      test(`a commenter suggests a feature from the chat (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.commenter);
        const drawer = await openDrawer(page);
        await drawer.getByRole("button", { name: "Ask Oracle in the chat" }).click();
        await expect(page.getByTestId("goal-panel")).toHaveCount(0);
        const box = page.getByRole("textbox", { name: "Message Oracle" }).filter({ visible: true });
        await expect(box).toHaveValue("Suggest a feature for Grow retention: ");
        await box.pressSequentially("weekly digest for admins so leads see what fired");
        await box.press("Enter");
        const chat = page.getByTestId("ask-chat-thread").filter({ visible: true });
        await expect(chat).toContainText("I understood one change: suggest Weekly digest for admins for Grow retention.");
        // The look-alike by its display code and name, never its key (suggest review).
        await expect(chat).toContainText("It looks like F-06 Weekly alert digest, which has a similar name.");
        await expect(chat).not.toContainText("alert-digest");
        const card = chat.getByTestId("chat-card");
        await expect(card).toHaveCount(1);
        await expect(card.getByRole("button", { name: "Preview" })).toBeVisible();
        await expect(card.getByRole("button", { name: "Discard" })).toBeVisible();
        await card.getByRole("button", { name: "Preview" }).click();
        await expect(card.getByTestId("chat-card-preview")).toContainText("Under People in the goal's suggestions");
        await card.getByRole("button", { name: "Apply" }).click();
        await expect(card).toHaveAttribute("data-status", "applied");
        await noSidewaysScroll(page, phone);

        await page.goto("/simple");
        const again = await openDrawer(page);
        await expect(again.getByRole("tab", { name: "People · 1" })).toBeVisible();
        await expect(again.locator('[data-testid="person-suggestion"][data-title="Weekly digest for admins"]')).toContainText("weekly digest for admins so leads see what fired");
      });

      /**
       * Card simple-suggest-chat-from-thread: protects = "Suggest from the chat" while the Ask
       * panel shows a chat thread brings back Ask's box with "Suggest a feature for Grow
       * retention: " typed in, at once (the words are never left waiting to show up later);
       * fails_when = the panel stays on the thread and the box (and its words) does not show;
       * no_claim = the thread's own answer (the mock's canned reply).
       */
      test(`"Suggest from the chat" from an open Ask thread (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.commenter);
        await page.getByTestId(phone ? "phone-ask" : "simple-ask").filter({ visible: true }).first().click();
        const panel = page.getByTestId("hop-panel").filter({ visible: true });
        await panel.getByRole("textbox", { name: "Message Oracle" }).fill("What should we cut first?");
        await panel.getByRole("button", { name: "Send" }).click();
        // ask-fresh: the panel's chat thread (SimpleAsk) shows the question asked.
        await expect(panel.getByTestId("ask-chat-thread").getByTestId("chat-message").first()).toBeVisible();
        if (phone) await page.keyboard.press("Escape");
        const drawer = await openDrawer(page);
        await drawer.getByRole("button", { name: "Ask Oracle in the chat" }).click();
        const box = page.getByRole("textbox", { name: "Message Oracle" }).filter({ visible: true });
        await expect(box).toHaveValue("Suggest a feature for Grow retention: ");
        await noSidewaysScroll(page, phone);
      });

      /**
       * Card simple-suggest-chat-again (train Z review): protects = "Suggest from the chat"
       * pressed a second time with the same words fills the box again after the person cleared
       * it, and pressed while the Ask panel shows Recent chats brings back the chat with the
       * words in its box; fails_when = the second press leaves the box empty, or the panel stays
       * on Recent chats; no_claim = the thread's own answer.
       */
      test(`"Suggest from the chat" again, and from Recent chats (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.commenter);
        let drawer = await openDrawer(page);
        await drawer.getByRole("button", { name: "Ask Oracle in the chat" }).click();
        const box = page.getByRole("textbox", { name: "Message Oracle" }).filter({ visible: true });
        await expect(box).toHaveValue("Suggest a feature for Grow retention: ");
        await box.fill("");
        if (phone) await page.keyboard.press("Escape");
        drawer = await openDrawer(page);
        await drawer.getByRole("button", { name: "Ask Oracle in the chat" }).click();
        await expect(box).toHaveValue("Suggest a feature for Grow retention: ");
        const panel = page.getByTestId("hop-panel").filter({ visible: true });
        await panel.getByTestId("ask-recent").click();
        await expect(panel.getByTestId("ask-recent-list")).toBeVisible();
        if (phone) {
          // Recent chats is a menu over the chat (ask-panel fidelity, pick C): Escape closes it first, then the sheet.
          await page.keyboard.press("Escape");
          await expect(panel.getByTestId("ask-recent-list")).toHaveCount(0);
          await page.keyboard.press("Escape");
        }
        drawer = await openDrawer(page);
        await drawer.getByRole("button", { name: "Ask Oracle in the chat" }).click();
        await expect(page.getByTestId("hop-panel").filter({ visible: true }).getByTestId("ask-recent-list")).toHaveCount(0);
        await expect(box).toHaveValue("Suggest a feature for Grow retention: ");
        await noSidewaysScroll(page, phone);
      });

      /**
       * Card simple-suggest-approver-decider: protects = with no named decider, the approver who
       * owns the goal roadmap's track decides its suggestions (as the API's drafts.can_edit):
       * the drawer names them ("Avery Lane will review your suggestion."), they see Accept / Reject with the form
       * folded and accept a commenter's suggestion; an owner who is not that decider still sees
       * Accept / Reject; a goal whose metric has no unit reads each figure with the metric
       * ("From 12 teams muting alerts · target 10 teams muting alerts", H1); fails_when = the
       * drawer names the owner, the approver cannot accept, the owner cannot, or a target is a
       * bare number; no_claim = a named decider on the goal's roadmap (api/tests).
       */
      test(`an approver who owns the goal's track decides its suggestions (${where})`, async ({ page, context }) => {
        await context.addInitScript(([key]) => localStorage.setItem(key, "simple-suggest-deciders"), [MOCK_SCENARIO_KEY]);
        await signIn(page, EMAILS.commenter);
        const quiet = page.getByTestId("home-goal").filter({ hasText: "Keep alerts quiet" });
        await expect(quiet.getByTestId("home-goal-path")).toHaveText("From 12 teams muting alerts · target 10 teams muting alerts");
        let drawer = await openDrawer(page);
        await expect(drawer.getByTestId("suggest-decider")).toHaveText("Avery Lane will review your suggestion.");
        const form = drawer.getByTestId("suggest-form");
        await form.getByLabel("Feature name").fill("Shared alert notes");
        await form.getByLabel("What it does, and for whom").fill("Leads leave a note on an alert so the next person on call knows what was tried");
        await form.getByRole("button", { name: "Send suggestion" }).click();
        await expect(toastWith(page, "Sent: Shared alert notes")).toBeVisible();
        await closeDrawer(page, phone);
        await signOutHere(page, phone);

        await signIn(page, EMAILS.owner);
        drawer = await openDrawer(page);
        const forOwner = drawer.locator('[data-testid="person-suggestion"][data-title="Shared alert notes"]');
        await expect(forOwner.getByRole("button", { name: "Accept" })).toBeVisible();
        await expect(forOwner.getByRole("button", { name: "Reject" })).toBeVisible();
        await closeDrawer(page, phone);
        await signOutHere(page, phone);

        await signIn(page, "avery.lane@example.com");
        drawer = await openDrawer(page);
        await expect(drawer.getByTestId("suggest-form-open")).toHaveText("+ Suggest a feature");
        const theirs = drawer.locator('[data-testid="person-suggestion"][data-title="Shared alert notes"]');
        await expect(theirs.getByRole("button", { name: "Reject" })).toBeVisible();
        await theirs.getByRole("button", { name: "Accept" }).click();
        await expect(toastWith(page, "Added Shared alert notes as a draft")).toBeVisible();
        await expect(theirs).toHaveCount(0);
        await noSidewaysScroll(page, phone);
      });

      /**
       * Card simple-suggest-viewer-priorities: protects = Priorities' goal bucket has the same one
       * button and drawer; a viewer reads both tabs with no form, no "Suggest from the chat", no
       * "Ask Oracle for more" and no Accept / Reject; fails_when = any of those shows to a viewer
       * or the bucket lists suggestions inline; no_claim = the buckets' header (plan-charts lane).
       */
      test(`a viewer reads a bucket's suggestions on Priorities (${where})`, async ({ page }) => {
        await signIn(page, EMAILS.viewer, "/simple/priorities?tab=buckets");
        const bucket = page.locator('[data-testid="goal-bucket"][data-key="grow-retention"]');
        await expect(bucket.getByTestId("goal-suggestion")).toHaveCount(0);
        await expect(bucket.getByTestId("goal-suggestions-open")).toHaveText("See suggestions · 1");
        await bucket.getByTestId("goal-suggestions-open").click();
        const drawer = page.getByTestId("goal-panel");
        await expect(drawer.getByTestId("suggest-form")).toHaveCount(0);
        await expect(drawer.getByRole("button", { name: "Ask Oracle in the chat" })).toHaveCount(0);
        await drawer.getByRole("tab", { name: "✦ Oracle · 1" }).click();
        await expect(drawer.getByTestId("goal-suggestion")).toHaveCount(1);
        await expect(drawer.getByRole("button", { name: "✦ Ask Oracle for more" })).toHaveCount(0);
        await expect(drawer.getByRole("button", { name: "Accept" })).toHaveCount(0);
      });
    });
  }
}
