import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN } from "./helpers";

/*
 * Running today's word pill where a feature is named outside Priorities and the roadmap:
 * a feature (or its roadmap item) Oracle's Ask answer cites, and the item a review meeting's
 * agenda takes next, and each roadmap item a one-pager's plan strip lists under its row. Each
 * pill is a button whose card says what the mark means and names the feature. Against the mock
 * (lib/api/mock/currentstate.ts: Weekly alert digest and Welcome video run today, Alert routing
 * by team with old proof, Setup checklist is being built, Sample data import is new), with the
 * mock's invented people; desktop and phone.
 *
 * Card: protects=the pill beside a feature an answer cites, beside the agenda's next item and
 * beside each roadmap item listed under a one-pager's plan-strip row (by the item's id), and
 * its card opening on a click with its meaning and proof; fails_when=no pill shows there, the
 * row lists no items, or clicking it opens no card; no_claim=the one-pager's lines (bets,
 * risks: they carry no feature or item id in the API).
 *
 * Card (cs2-b, the owner's later pick: the pill always follows the name): protects=the pill right
 * after every feature an Ask answer names in its words (not only its title, and not only after a
 * marker), after each "What we build" line's name on the plan-led one-pager (its feature found
 * through the PRD's roadmap item for the slice), and after a Detailed › Plan item's name (its
 * traced feature); fails_when=a named feature has no pill, the pill is not the next thing after
 * the name, or a line with a feature shows none; no_claim=which words a model writes.
 */

const PHONE = { width: 390, height: 844 };

/** The pill follows the name, as chips do (owner, Nov 4): to its right on the same line, or on a line under it. */
async function pillAfter(name: Locator, pill: Locator) {
  const n = (await name.boundingBox())!;
  const p = (await pill.boundingBox())!;
  const sameLine = p.y < n.y + n.height && n.y < p.y + p.height;
  expect(sameLine ? p.x >= n.x + n.width - 1 : p.y >= n.y + n.height - 1, "the pill comes after the name").toBe(true);
}

/** Per pill in `box`: the words just before it and its own word (the pill is the next thing after a name). */
async function pillsAfterWords(box: Locator): Promise<{ before: string; word: string; afterSource: boolean }[]> {
  return box.getByTestId("answer-mark").evaluateAll((els) =>
    els.map((el) => ({
      before: (el.previousSibling?.textContent ?? "").trim(),
      word: el.querySelector('[data-testid="cs-mark"]')?.textContent ?? "",
      afterSource: el.previousSibling?.nodeName === "SUP",
    })),
  );
}

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

for (const size of ["desktop", "phone"] as const) {
  test.describe(size, () => {
    if (size === "phone") test.use({ viewport: PHONE });

    test(`an Ask answer's feature carries its pill, and the pill opens its card (${size})`, async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      await signIn(page, "/simple");
      await tap(page.getByTestId(size === "phone" ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const panel = page.getByTestId("hop-panel").filter({ visible: true });
      await expect(panel.getByTestId("ask-chat")).toBeVisible();
      await say(panel, "what is Weekly alert digest about and when does it run?");

      const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      const title = reply.getByTestId("answer-title");
      await expect(title).toContainText("Weekly alert digest");
      await expect(title.getByTestId("cs-mark")).toHaveText("Exists");
      // The title reads the name first, its pill last (the name is the title's own text).
      await expect(title).toHaveText(/^Weekly alert digest.*Exists$/);

      await tap(title.getByRole("button", { name: "What Exists means" }));
      const card = reply.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Weekly alert digest");
      await expect(card).toContainText("Runs today");
    });

    test(`every feature an Ask answer names in its words carries its pill right after the name (${size})`, async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-chat"), MOCK_SCENARIO_KEY);
      await signIn(page, "/simple");
      await tap(page.getByTestId(size === "phone" ? "phone-ask" : "simple-ask").filter({ visible: true }).first());
      const panel = page.getByTestId("hop-panel").filter({ visible: true });
      await expect(panel.getByTestId("ask-chat")).toBeVisible();
      await say(panel, "what is left on the Alerts roadmap?");

      const reply = panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last();
      await expect(reply).toHaveAttribute("data-status", "complete");
      await expect(reply.getByTestId("answer-title")).toHaveText("What is left on the Alerts roadmap");
      const line = reply.getByTestId("chat-message-body").locator("p").filter({ hasText: "not done yet" });
      await expect(line).toContainText("Weekly alert digest");
      await expect(line).toContainText("Alert routing by team");
      // Each name in the line is followed by its own pill, not only the title's or the marker's.
      await expect(line.getByTestId("cs-mark").first()).toBeVisible();
      await expect.poll(async () => (await pillsAfterWords(line)).find((p) => p.before.endsWith("Weekly alert digest"))?.word).toBe("Exists");
      const pills = await pillsAfterWords(line);
      expect(pills.find((p) => p.before.endsWith("Alert routing by team"))?.word).toBe("Exists · proof old");
      expect(pills.length, "a pill after each item named").toBeGreaterThanOrEqual(4);
      // A feature named in words carries one pill, after its name: none again after the line's marker.
      await expect(line.getByTestId("cs-mark")).toHaveCount(pills.length);
      expect(pills.every((p) => !p.afterSource), "no pill after a source number").toBe(true);
      // No raw marker or token is shown.
      await expect(line).not.toContainText("[c:");
      // The pill after a name opens that feature's card.
      const digest = line.getByTestId("answer-mark").nth(pills.findIndex((p) => p.before.endsWith("Weekly alert digest")));
      await tap(digest.getByRole("button", { name: "What Exists means" }));
      const card = digest.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Weekly alert digest");
      await expect(card).toContainText("Runs today");
    });

    test(`each "What we build" line of the plan-led one-pager carries its feature's pill after its name (${size})`, async ({ context, page }) => {
      await context.addInitScript((key) => localStorage.setItem(key, "simple-plan"), MOCK_SCENARIO_KEY);
      await signIn(page, "/simple/one-pagers/guided-setup");
      const builds = page.getByTestId("milestone-part").getByTestId("part-builds");
      await expect(builds).toContainText("What we build");
      const lines = builds.getByRole("listitem");
      await expect(lines.first().getByTestId("cs-mark")).toBeVisible();
      const n = await lines.count();
      expect(n).toBeGreaterThan(2);
      for (let i = 0; i < n; i += 1) {
        const l = lines.nth(i);
        await expect(l.getByTestId("cs-mark"), "every line's feature is on the roadmap").toHaveCount(1);
        await expect(l.getByTestId("cs-mark")).toHaveText(/^(New|In progress|Exists|Exists · proof old)$/);
        await pillAfter(l.getByTestId("part-build-name"), l.getByTestId("cs-mark"));
      }
      // The pill is that feature's: its card names the line's feature.
      const whole = lines.filter({ hasNotText: /part \d of \d/ }).first();
      const name = (await whole.getByTestId("part-build-name").textContent())!.trim();
      const word = (await whole.getByTestId("cs-mark").textContent())!.trim();
      await tap(whole.getByRole("button", { name: `What ${word} means` }));
      const card = whole.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText(name);
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size === "phone" ? PHONE.width : 1440);
    });

    test(`a Detailed Plan item carries its feature's pill right after its name (${size})`, async ({ page }) => {
      await signIn(page, "/plan");
      await expect(page.getByRole("heading", { level: 1, name: "Plan" })).toBeVisible();
      const rows = page.getByTestId("plan-row").filter({ visible: true });
      const traced = rows.filter({ hasText: "Threshold alerts on spend" });
      const pill = traced.getByTestId("plan-name").getByTestId("cs-mark");
      await expect(pill).toHaveText("New");
      await pillAfter(traced.getByTestId("plan-title"), pill);
      // Beside the name, not across the cell: on its line, a small gap after the words.
      const t = (await traced.getByTestId("plan-title").boundingBox())!;
      const p = (await pill.boundingBox())!;
      if (p.y < t.y + t.height && t.y < p.y + p.height) expect(p.x - (t.x + t.width)).toBeLessThanOrEqual(16);
      // An item with no feature behind it shows none.
      await expect(rows.filter({ hasText: "Weekly alert digest" }).getByTestId("cs-mark")).toHaveCount(0);
      await tap(traced.getByRole("button", { name: "What New means" }));
      const card = traced.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Threshold alerts");
      await expect(card).toContainText("Nothing built yet");
    });

    test(`a one-pager lists each plan-strip row's items with their pills (${size})`, async ({ page }) => {
      await signIn(page, "/simple/prds/guided-setup");
      const strip = page.getByLabel("Timeline strip");
      const row = (name: string) => strip.getByRole("listitem").filter({ has: page.getByTestId("plan-strip-label").filter({ hasText: name }) });
      const m1 = row("Milestone M1 · 12 roadmap items");
      await expect(m1.getByTestId("plan-strip-item")).toHaveCount(12);
      await expect(m1.getByTestId("plan-strip-item").first()).toContainText("Setup checklist");
      const item = (r: Locator, name: string) => r.getByTestId("plan-strip-item").filter({ hasText: name });
      // An item with no feature behind it is listed, with no pill.
      await expect(item(m1, "Setup step 3")).toBeVisible();
      await expect(item(m1, "Setup step 3").getByTestId("cs-mark")).toHaveCount(0);

      const kinds: [Locator, string, string, string, RegExp][] = [
        [m1, "Setup checklist", "In progress", "Being built", /4 merged pull requests/],
        [m1, "Sample data import", "New", "Nothing built yet", /No merged pull requests or done tasks yet/],
        [row("Milestone M2 · 5 roadmap items"), "Welcome video", "Exists", "Runs today, with proof", /11 merged pull requests/],
        [row("No milestone · 2 roadmap items"), "Alert routing by team", "Exists · proof old", "more than 30 days old", /4 merged pull requests/],
      ];
      for (const [r, name, word, means, proof] of kinds) {
        const it = item(r, name);
        await expect(it.getByTestId("cs-mark")).toHaveText(word);
        await pillAfter(it.getByText(name, { exact: true }), it.getByTestId("cs-mark"));
        await tap(it.getByRole("button", { name: `What ${word} means` }));
        const card = it.getByTestId("cs-mark-card");
        await expect(card).toBeVisible();
        await expect(card).toContainText(name);
        await expect(card).toContainText(means);
        await expect(card).toContainText(proof);
        await page.keyboard.press("Escape");
        await expect(card).toHaveCount(0);
      }
      // The page still fits a phone.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size === "phone" ? PHONE.width : 1440);
    });

    test(`the meeting agenda's next item carries its pill, and the pill opens its card (${size})`, async ({ page }) => {
      await signIn(page, "/simple/prds/guided-setup");
      await tap(page.getByRole("button", { name: "Start a review meeting" }));
      const sheet = page.getByRole("dialog", { name: "Start a review" });
      await sheet.getByRole("checkbox", { name: "Theo Brandt" }).check();
      await tap(sheet.getByRole("button", { name: "Start", exact: true }));
      await expect(page.getByRole("heading", { name: "Review: Guided setup" })).toBeVisible();

      const chat = page.getByTestId("meeting-chat");
      await say(chat, "next: Setup checklist");
      const cardIn = chat.getByTestId("chat-card").filter({ has: page.getByTestId("chat-card-summary").filter({ hasText: "Take Setup checklist next" }) }).last();
      await tap(cardIn.getByRole("button", { name: "Apply" }));
      await expect(cardIn.getByTestId("chat-card-outcome")).toContainText("Applied by you");

      const strip = page.getByTestId("agenda-strip");
      await expect(page.getByTestId("agenda-next")).toHaveText("Next: Setup checklist");
      await expect(strip.getByTestId("cs-mark")).toHaveText("In progress");
      await pillAfter(page.getByTestId("agenda-next"), strip.getByTestId("cs-mark"));

      await tap(strip.getByRole("button", { name: "What In progress means" }));
      const card = strip.getByTestId("cs-mark-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText("Setup checklist");
      await expect(card).toContainText("Being built");
    });
  });
}
