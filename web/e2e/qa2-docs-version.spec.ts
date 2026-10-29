import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login, openTab, showAll } from "./helpers";

// QA pass 2, docs lane: a document version's page and its tabs (the roadmap's Items, a
// technical brief on a phone, the review bar, Discuss, History's reports, suggestion cards,
// Impact), the feedback campaign's form and Quality's rating form, driven as a person.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const ROADMAP = "/documents/usage-alerts-roadmap/v/1";
const ITEMS = `${ROADMAP}/items`;
const CARTS = "/documents/saved-carts/v/2";
const BRIEF_V2 = "/documents/checkout-redesign-early-shipping-cost-spec/v/2";

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

async function asRole(page: Page, role: "viewer" | "commenter" | "approver" | "owner") {
  await page.addInitScript(([k, r]) => localStorage.setItem(k, r), [MOCK_ROLE_KEY, role] as const);
}

/** A disabled button still reads as a button: an outline unlike its own fill (and the panel's). */
async function outline(button: Locator): Promise<{ width: number; differs: boolean }> {
  return button.evaluate((el) => {
    el.getAnimations().forEach((a) => a.finish());
    const s = getComputedStyle(el);
    return { width: parseFloat(s.borderTopWidth), differs: s.borderTopColor !== s.backgroundColor };
  });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop, ${scheme}`, () => {
    test.use({ viewport: DESKTOP, colorScheme: scheme });

    // qa-docs-3: why the roadmap cannot be approved is the reviewers' to see too.
    for (const email of ["commenter@example.com", "viewer@example.com"]) {
      test(`qa-docs-3: a ${email.split("@")[0]} sees why the roadmap cannot be approved, with no Approve`, async ({ page }) => {
        await login(page, email);
        for (const url of [ITEMS, ROADMAP]) {
          await page.goto(url);
          const note = visible(page, "approve-blocked-note");
          await expect(note).toContainText("1 date is not backed by a confirmed schedule");
          await expect(page.getByRole("button", { name: "Approve version" })).toHaveCount(0);
        }
      });
    }

    test("qa-docs-3: the owner keeps the blocked Approve and its reason, said once", async ({ page }) => {
      await login(page);
      await page.goto(ITEMS);
      await expect(visible(page, "approve-blocked")).toContainText("1 date is not backed by a confirmed schedule");
      await expect(page.getByTestId("approve-blocked-note")).toHaveCount(0);
    });

    // qa-docs-5: a disabled Save on the review bar (a surface2 panel) still reads as a button,
    // and says what it waits for.
    test("qa-docs-5: Save: Rejected with no note is an outlined button with a hint", async ({ page }) => {
      await login(page);
      await page.goto(CARTS);
      await expect(page.getByTestId("document-sections")).toBeVisible();
      const bar = visible(page, "review-bar").first();
      await bar.getByRole("button", { name: "Reject", exact: true }).click();
      const save = bar.getByRole("button", { name: /^Save: Rejected/ });
      await expect(save).toBeDisabled();
      const o = await outline(save);
      expect(o.width).toBeGreaterThanOrEqual(1);
      expect(o.differs).toBe(true);
      await expect(bar.getByTestId("verdict-save-hint")).toHaveText("Write a note first");
      await bar.getByRole("textbox").fill("The cart limit is not decided.");
      await expect(save).toBeEnabled();
      await expect(bar.getByTestId("verdict-save-hint")).toHaveCount(0);
    });

    test("qa-docs-5: Ask for feedback's Send with no title is an outlined button with a hint", async ({ page }) => {
      await asRole(page, "approver");
      await login(page);
      await page.goto("/documents/checkout-redesign");
      const panel = page.getByTestId("campaigns");
      await panel.getByRole("button", { name: "Ask for feedback" }).click();
      const send = panel.getByRole("button", { name: "Send" });
      await expect(send).toBeDisabled();
      const o = await outline(send);
      expect(o.width).toBeGreaterThanOrEqual(1);
      expect(o.differs).toBe(true);
      await expect(panel.getByTestId("campaign-send-hint")).toHaveText("Add a title to send");
      await panel.getByLabel("Title").fill("Pilot read-through");
      await expect(send).toBeEnabled();
      await expect(panel.getByTestId("campaign-send-hint")).toHaveCount(0);
    });

    test("qa-docs-5: Quality's disabled Submit rating is an outlined button beside its hint", async ({ page }) => {
      await asRole(page, "commenter");
      await login(page);
      await page.goto(`${CARTS}/quality`);
      await page.locator('[data-testid="criterion-row"][data-key="alternatives_tradeoffs"]').click();
      const form = page.getByTestId("quality-inspector").getByTestId("rating-form");
      await form.getByRole("button", { name: "Warning" }).click();
      const submit = form.getByRole("button", { name: "Submit rating" });
      await expect(submit).toBeDisabled();
      const o = await outline(submit);
      expect(o.width).toBeGreaterThanOrEqual(1);
      expect(o.differs).toBe(true);
      await expect(form.getByTestId("rating-hint")).toHaveText("Add a reason to submit");
    });

    // qa-docs-33: the whole-document Discuss form: no greyed-out ticked box, and who answers is
    // said above the buttons, not cut off at the panel's foot.
    test("qa-docs-33: Discuss says Oracle will reply in words, above Start discussion", async ({ page }) => {
      await login(page);
      await page.goto(CARTS);
      await page.getByTestId("doc-discuss").click();
      const form = visible(page, "start-discussion");
      await expect(form.getByRole("checkbox", { name: "Ask Oracle" })).toHaveCount(0);
      const rule = form.getByTestId("oracle-rule");
      await expect(rule).toHaveText("Oracle will reply");
      const r = (await rule.boundingBox())!;
      const start = (await form.getByRole("button", { name: "Start discussion" }).boundingBox())!;
      expect(r.y + r.height).toBeLessThanOrEqual(start.y);
      // With others in it, the box is there to tick, enabled.
      await form.getByRole("group", { name: "Visible to" }).getByRole("button", { name: "Only people I pick" }).click();
      await form.getByRole("searchbox", { name: "Find a person" }).fill("approver");
      await form.getByRole("option", { name: /Approver/ }).click();
      await expect(form.getByRole("checkbox", { name: "Ask Oracle" })).toBeEnabled();
    });

    // qa-docs-13: after a failed report job, one way to write again.
    test("qa-docs-13: a failed report offers Retry only, not Write again beside it", async ({ page }) => {
      await login(page);
      await page.goto(CARTS);
      await openTab(page, "History");
      const reports = visible(page, "history-reports").getByTestId("reports-panel");
      await expect(reports.getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(reports.getByRole("button", { name: /^Write/ })).toHaveCount(0);
      await expect(reports.getByRole("button", { name: /^(Retry|Write)/ })).toHaveCount(1);
    });

    // qa-docs-12: no internal grouping key on a suggestion card.
    test("qa-docs-12: a suggestion card shows its classification, not Oracle's grouping key", async ({ page }) => {
      await login(page);
      await page.goto("/documents/team-workspaces/v/2");
      await openTab(page, "Feedback");
      await showAll(page);
      const card = page
        .getByTestId("feedback-item")
        .filter({ visible: true, hasText: "how many teams asked" })
        .getByTestId("suggestion");
      await expect(card).toContainText("Change request");
      await expect(card).not.toContainText("demand figure");
      await expect(card.locator(".font-mono")).toHaveCount(0);
    });

    // qa-docs-25: no lone Preview badge under the breadcrumb; the line under it says it in words.
    test("qa-docs-25: a version's Impact has no unexplained Preview badge", async ({ page }) => {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, "impact"] as const);
      await login(page);
      await page.goto("/documents/checkout-redesign/v/2");
      await page.getByRole("link", { name: "Impact", exact: true }).click();
      await expect(page.getByText("Preview: nothing has been marked stale.")).toBeVisible();
      const header = page.locator("header[data-page-header]").filter({ visible: true });
      await expect(header.getByText("Preview", { exact: true })).toHaveCount(0);
    });
  });

  test.describe(`phone, ${scheme}`, () => {
    test.use({ viewport: PHONE, colorScheme: scheme, hasTouch: true });

    test("qa-docs-3: a commenter on a phone sees why the roadmap cannot be approved", async ({ page }) => {
      await login(page, "commenter@example.com");
      await page.goto(ITEMS);
      await expect(visible(page, "approve-blocked-note")).toContainText("1 date is not backed by a confirmed schedule");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });

    // qa-docs-8: the Sections / Review bar sits on the tab bar; a section's Prev/Next scrolled
    // into view, or at the page's end, clears both bars.
    test("qa-docs-8: a section's Prev/Next clears the Sections / Review bar and the tab bar", async ({ page }) => {
      await login(page);
      await page.goto(BRIEF_V2);
      await expect(page.getByTestId("document-sections")).toBeVisible();
      const nav = page.getByRole("navigation", { name: "Previous and next section" }).filter({ visible: true });
      const bar = visible(page, "phone-bar");
      await expect(bar).toBeVisible();
      await expect
        .poll(async () => {
          await nav.evaluate((el) => el.scrollIntoView({ block: "end" }));
          const n = (await nav.boundingBox())!;
          const b = (await bar.boundingBox())!;
          return Math.round(b.y - (n.y + n.height));
        })
        .toBeGreaterThanOrEqual(-1);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect
        .poll(async () => {
          const n = (await nav.boundingBox())!;
          const b = (await bar.boundingBox())!;
          return b.y - (n.y + n.height);
        })
        .toBeGreaterThanOrEqual(0);
      const tabs = (await page.getByTestId("tab-bar").boundingBox())!;
      const b = (await bar.boundingBox())!;
      expect(b.y + b.height).toBeLessThanOrEqual(tabs.y + 1);
    });

    // qa-docs-9: the Items tab's last row clears the tab bar, at the page's end and scrolled into view.
    test("qa-docs-9: the last item row (Success metrics) clears the tab bar", async ({ page }) => {
      await login(page);
      await page.goto(ITEMS);
      const last = page.locator('[data-testid="roadmap-item-row"][data-key="item-metrics"]').filter({ visible: true });
      await expect(last).toBeVisible();
      const tabs = visible(page, "tab-bar");
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect
        .poll(async () => {
          const r = (await last.boundingBox())!;
          const t = (await tabs.boundingBox())!;
          return t.y - (r.y + r.height);
        })
        .toBeGreaterThanOrEqual(8);
      await last.evaluate((el) => el.scrollIntoView({ block: "end" }));
      const r = (await last.boundingBox())!;
      const t = (await tabs.boundingBox())!;
      expect(r.y + r.height).toBeLessThanOrEqual(t.y + 1);
    });
  });
}
