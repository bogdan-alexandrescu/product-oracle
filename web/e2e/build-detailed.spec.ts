import { expect, test, type Page } from "./test";

import { ROADMAP_OVER_LIMIT_SCENARIO } from "../lib/api/mock/runs";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { WEBHOOKS_SCENARIO } from "../lib/api/mock/webhooks";
import { login } from "./helpers";

/*
 * The picked Detailed screens (mock-up picks, Nov 1), driven as a person would on the mock, on
 * a desktop and a phone:
 * - QD1 a: Held rewrites opens as a drawer over the page, at the window's full height.
 * - QD2 a: Draft roadmap and Re-plan open a dialog that prices the run: Start for $N, or over
 *   the limit Approve $N and start for an owner.
 * - QD3 a: File as request opens the New request form, filled in from the found item.
 * - QD4 a: the delivery log is cards in the side panel; a new template is sections as fields,
 *   with Edit as Markdown kept.
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

const SIZES = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;

const scenario = (page: Page, name: string) =>
  page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport });
    const phone = size.name === "phone";

    test("QD1 a drawer on top: held rewrites open over the page at full height, with room for Reason and Accept", async ({ page }) => {
      // protects=Held rewrites opens as a drawer (from the right; from the bottom on a phone),
      // nearly the window's height, over a page that keeps its layout; a rewrite has its text,
      // Reason and Accept; Accept makes version 3 and the drawer closes back to the page;
      // fails_when=the rewrites open inline above the sections, or squeezed; no_claim=Reject (section-edit).
      await login(page);
      await page.goto("/documents/checkout-redesign/v/2");
      await expect(page.getByTestId("document-sections")).toBeVisible();
      const layout = page.getByTestId("prd-layout");
      // Where the page's panels sit in the document (scroll aside).
      const place = () => layout.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
      });
      const before = await place();

      const open = page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true });
      await expect(open.getByTestId("held-count")).toHaveText("1");
      await open.click();
      const drawer = page.getByRole("dialog", { name: "Held rewrites" });
      await expect(drawer).toBeVisible();
      const box = (await drawer.boundingBox())!;
      if (phone) {
        // From the bottom, the full width; it grows with its rewrites up to near the top.
        expect(box.width).toBeGreaterThan(size.viewport.width * 0.95);
        expect(box.y + box.height).toBeGreaterThan(size.viewport.height - 2);
      } else {
        // From the right, the window's full height, a readable width.
        expect(box.height).toBeGreaterThan(size.viewport.height * 0.95);
        expect(box.x + box.width).toBeGreaterThan(size.viewport.width - 2);
        expect(box.width).toBeLessThan(size.viewport.width * 0.6);
        // The page behind keeps its layout: the same panels in the same place, give or take the
        // window's scrollbar, which the drawer locks (its width can rewrap a line above them).
        const after = await place();
        expect(Math.abs(after.x - before.x)).toBeLessThan(2);
        expect(Math.abs(after.y - before.y)).toBeLessThan(16);
        expect(Math.abs(after.width - before.width)).toBeLessThan(20);
      }

      const item = drawer.getByTestId("held-rewrite");
      await expect(item).toContainText("Goal trace");
      await expect(item.locator("ins")).toContainText(["An", "agent", "proposed"]);
      await item.getByLabel("Reason").fill("Reads better with the added sentence.");
      await expect(item.getByRole("button", { name: "Accept" })).toBeInViewport();
      await item.getByRole("button", { name: "Accept" }).click();
      await expect(page).toHaveURL(/\/v\/3#goal-trace$/);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(page.getByRole("button", { name: /^Held rewrites/ }).filter({ visible: true }).getByTestId("held-count")).toHaveCount(0);
      expect(await noSideScroll(page)).toBe(true);
    });

    test("QD2 confirm in a dialog: Draft roadmap prices its parts and starts for its price", async ({ page }) => {
      // protects=Draft roadmap from this track… opens a dialog saying what the run does, its two
      // priced parts and the total, with Start for $14.50 that starts the run; Cancel starts
      // nothing; fails_when=the button starts a run at once with no price shown;
      // no_claim=the run's own checkpoints (runs specs).
      await login(page);
      await page.getByRole("navigation", { name: "Oracle" }).getByRole("link", { name: "Plan", exact: true }).click();
      await expect(page).toHaveURL(/\/plan$/);
      const track = page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
      await track.getByRole("button", { name: "Draft roadmap from this track…" }).click();
      const dialog = page.getByRole("dialog", { name: "Draft a roadmap from this track" });
      await expect(dialog).toContainText("Oracle drafts a roadmap from Usage alerts");
      await expect(dialog).toContainText("in two parts priced below, and stops for your review before anything is saved.");
      await expect(dialog.getByTestId("estimate-row-roadmap_items")).toContainText("Roadmap items");
      await expect(dialog.getByTestId("estimate-row-roadmap_draft")).toContainText("Roadmap draft");
      await expect(dialog.getByTestId("estimate-total")).toHaveText("$14.50");
      await expect(dialog).toContainText("Nothing is charged until you start it.");
      await expect(page).toHaveURL(/\/plan$/);
      await dialog.getByRole("button", { name: "Start for $14.50" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      await expect(page.getByTestId("run-status").filter({ visible: true }).first()).toHaveText(/Running|Queued/);
    });

    test("QD2 over the limit an owner approves in the same dialog", async ({ page }) => {
      // protects=the hard case: a run over the $50 limit shows Owner approves, and the owner's
      // button says Approve $58.00 and start; the run starts approved; fails_when=it starts
      // with no approval or the button hides the price; no_claim=a non-owner (Ask an owner to approve).
      await scenario(page, ROADMAP_OVER_LIMIT_SCENARIO);
      await login(page);
      await page.goto("/plan");
      const track = page.getByTestId("plan-track").filter({ visible: true }).filter({ hasText: "Usage alerts" });
      await track.getByRole("button", { name: "Draft roadmap from this track…" }).click();
      const dialog = page.getByRole("dialog", { name: "Draft a roadmap from this track" });
      await expect(dialog.getByTestId("estimate-total")).toHaveText("$58.00");
      await expect(dialog).toContainText("Owner approves");
      await dialog.getByRole("button", { name: "Approve $58.00 and start" }).click();
      await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
      await expect(page.getByTestId("run-status").filter({ visible: true }).first()).not.toHaveText("Awaiting approval");
    });

    test("QD2 Re-plan on a slipped plan item opens the same dialog, as Re-plan this track", async ({ page }) => {
      // protects=Re-plan… opens the priced dialog named Re-plan this track; Cancel closes it and
      // stays on the Plan; fails_when=Re-plan starts a run at once; no_claim=the slip's other actions.
      await scenario(page, "track-alerts");
      await login(page);
      await page.goto("/plan");
      await page.getByTestId("plan-row").filter({ visible: true }).filter({ hasText: "Weekly alert digest" }).getByTestId("plan-title").click();
      const card = page.getByTestId("plan-inspector").filter({ visible: true }).getByTestId("plan-alert");
      await card.getByRole("button", { name: "Re-plan…" }).click();
      const dialog = page.getByRole("dialog", { name: "Re-plan this track" });
      await expect(dialog).toContainText("Oracle drafts the roadmap for");
      await expect(dialog.getByRole("button", { name: /^Start for \$/ })).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/\/plan/);
    });

    test("QD3 one form, two doors: File as request opens New request filled in, with what filing shares", async ({ page }) => {
      // protects=File as request opens the New request form filled in from the found item, with
      // Customer or team and what filing shares; File request files it, it leaves the found list
      // and opens selected at the top of All requests; New request opens the same form blank;
      // fails_when=a second, different form opens; no_claim=the API's filing (test_requests_triage.py).
      await login(page);
      await page.goto("/requests");
      const found = page.getByTestId("found-in-sources");
      await expect(found).toContainText("Oracle found 2 possible requests in your sources");
      await found.getByTestId("found-item").filter({ hasText: "Reorder last week's basket" }).getByRole("button", { name: "File as request" }).click();

      const dialog = page.getByRole("dialog", { name: "New request" });
      await expect(dialog.getByLabel("Title")).toHaveValue("Reorder last week's basket");
      await expect(dialog.getByLabel("What it is and why")).toHaveValue(/Could I reorder what I bought last week in one click\?/);
      await expect(dialog.getByLabel("Channel")).toHaveValue("support");
      await expect(dialog.getByTestId("filing-shares")).toHaveText(
        "Found in #support thread. Filing shares this item: everyone who can see Requests reads its title, link and this excerpt.",
      );
      await expect(dialog.getByTestId("filing-excerpt")).toContainText("Could I reorder what I bought last week");
      await dialog.getByRole("group", { name: "Customer or team" }).getByRole("button", { name: "Customer" }).click();
      await dialog.getByLabel("Title").fill("Reorder last week's basket in one click");
      await dialog.getByRole("button", { name: "File request" }).click();

      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("filed-notice")).toContainText("Reorder last week's basket in one click");
      await expect(found).toContainText("Oracle found 1 possible request in your sources");
      const filed = page.getByTestId("all-requests").getByText("Reorder last week's basket in one click").filter({ visible: true }).first();
      await expect(filed).toBeVisible();
      if (phone) {
        // RQ-1 (PR 1312): under 1100 px the filed request opens in the full-height Request sheet;
        // closing it keeps the row picked, back on the list.
        const sheet = page.getByRole("dialog", { name: "Request" });
        await expect(sheet.getByTestId("request-inspector")).toContainText("Reorder last week's basket in one click");
        await sheet.getByRole("button", { name: "Close Request" }).click();
        await expect(sheet).toHaveCount(0);
        await expect(page.getByTestId("all-requests").getByTestId("request-row").filter({ hasText: "Reorder last week's basket in one click" }).first()).toHaveAttribute("aria-current", "true");
      }

      await page.getByRole("button", { name: "New request" }).filter({ visible: true }).first().click();
      const blank = page.getByRole("dialog", { name: "New request" });
      await expect(blank.getByLabel("Title")).toHaveValue("");
      await expect(blank.getByTestId("filing-shares")).toHaveCount(0);
      await expect(blank.getByRole("group", { name: "Customer or team" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });

    test("QD4 cards: the delivery log is two-line cards in the side panel", async ({ page }) => {
      // protects=each delivery is a card: what happened in words with its status, then the time,
      // what the server answered in words (F-64: no HTTP numbers) and time taken; a card opens the delivery, headed by its name; the Status and
      // Event filters and Company time stay; fails_when=the log is a table that cuts its
      // columns; no_claim=redeliver (webhooks.spec).
      await scenario(page, WEBHOOKS_SCENARIO);
      await login(page);
      await page.goto("/settings/webhooks");
      await page.getByTestId("webhook-row").filter({ visible: true }).filter({ hasText: "Deploy notifier" }).click();
      const log = page.getByTestId("delivery-log").filter({ visible: true });
      await expect(log.getByLabel("Status")).toBeVisible();
      await expect(log.getByLabel("Event")).toBeVisible();
      await expect(log).toContainText("Times are in Company time.");
      await expect(log.getByRole("table")).toHaveCount(0);
      const cards = log.getByTestId("delivery-cards").getByTestId("delivery-row");
      await expect(cards.first()).toBeVisible();
      const first = cards.first();
      await expect(first.getByTestId("delivery-facts")).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, .+ · (Answered OK|Server answered with an error) · \d+ ms$/);
      await expect(first).not.toContainText(/\b[a-z]+\.[a-z_]+\b/);
      const failed = cards.filter({ hasText: "Server answered with an error" }).first();
      await expect(failed).toBeVisible();
      const name = (await failed.locator("span").first().locator("span").first().innerText()).trim();
      await failed.click();
      const detail = page.getByRole("dialog", { name: "Delivery" });
      await expect(detail).toContainText(name);
      await expect(detail.getByRole("button", { name: "Redeliver" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });

    test("QD4 fields: a new template is sections as fields, with Edit as Markdown kept", async ({ page }) => {
      // protects=New template shows one row per section (heading, guide, Show in the brief), Sources
      // and data points last; the key is made from the name; a section is added; Edit as
      // Markdown shows the same template as checked text; Create template opens it;
      // fails_when=the page opens on raw Markdown or asks for a key; no_claim=changing a later version.
      await login(page);
      await page.goto("/settings/templates");
      await page.getByRole("link", { name: "New template" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "New template" })).toBeVisible();
      const sections = page.getByTestId("template-section");
      await expect(sections).toHaveCount(3);
      await expect(page.getByLabel("Section 1 heading")).toHaveValue("Problem");
      await expect(page.getByTestId("template-sections")).toContainText("Sources and data points");
      await expect(page.getByRole("textbox", { name: "Key" })).toHaveCount(0);
      await page.getByTestId("template-name").fill("Launch brief");
      await expect(page.getByTestId("template-key")).toHaveText("Key: launch-brief");
      await page.getByRole("button", { name: "Add a section" }).click();
      await page.getByLabel("Section 4 heading").fill("Support readiness");
      await page.getByLabel("Section 4 guide").fill("Who answers the first questions, and with what.");

      await page.getByRole("button", { name: "Edit as Markdown" }).click();
      await expect(page.getByLabel("Body", { exact: true })).toHaveValue(/## Support readiness \{#support-readiness\}/);
      await expect(page.getByTestId("validation-ok")).toContainText("Support readiness");
      await page.getByRole("button", { name: "Create template" }).click();
      await expect(page).toHaveURL(/\/settings\/templates\/launch-brief$/);
      await expect(page.getByRole("heading", { level: 1, name: "Launch brief" })).toBeVisible();
      await expect(page.getByTestId("version-body")).toContainText("## Support readiness {#support-readiness}");
      expect(await noSideScroll(page)).toBe(true);
    });

    test("review: File as request asks before Escape throws away an edited body", async ({ page }) => {
      // protects=in a form filled from a found item, editing What it is and why and pressing
      // Escape asks "Discard your changes?"; Keep editing keeps the words; fails_when=the edit
      // is thrown away without asking; no_claim=the blank New request form (requests-new.spec).
      await login(page);
      await page.goto("/requests");
      const found = page.getByTestId("found-in-sources");
      await found.getByTestId("found-item").filter({ hasText: "Reorder last week's basket" }).getByRole("button", { name: "File as request" }).click();
      const dialog = page.getByRole("dialog", { name: "New request" });
      const body = dialog.getByLabel("What it is and why");
      await body.fill("They want to reorder a past basket from the order page.");
      await body.press("Escape");
      await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(body).toHaveValue("They want to reorder a past basket from the order page.");
    });

    test("review: Back to fields asks before it throws away Markdown edits", async ({ page }) => {
      // protects=after typing in Edit as Markdown, Back to fields asks "Discard your changes?";
      // Keep editing keeps the Markdown, Discard shows the fields; unchanged Markdown goes back
      // without asking; fails_when=the edits are dropped without asking; no_claim=leaving the page.
      await login(page);
      await page.goto("/settings/templates/new");
      await page.getByRole("button", { name: "Edit as Markdown" }).click();
      await page.getByRole("button", { name: "Back to fields" }).click();
      await expect(page.getByTestId("template-section")).toHaveCount(3);

      await page.getByRole("button", { name: "Edit as Markdown" }).click();
      const md = page.getByLabel("Body", { exact: true });
      await md.fill(`${await md.inputValue()}\nA line typed by hand.`);
      await page.getByRole("button", { name: "Back to fields" }).click();
      const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
      await expect(ask).toBeVisible();
      await ask.getByRole("button", { name: "Keep editing" }).click();
      await expect(md).toHaveValue(/A line typed by hand\./);
      await page.getByRole("button", { name: "Back to fields" }).click();
      await ask.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page.getByTestId("template-section")).toHaveCount(3);
    });

    test("review: a one-letter name cannot make a template", async ({ page }) => {
      // protects=a name whose key would be one letter keeps Create template off and says why;
      // two letters turn it on; fails_when=Create turns on and the save is refused; no_claim=keys taken.
      await login(page);
      await page.goto("/settings/templates/new");
      const create = page.getByRole("button", { name: "Create template" });
      await page.getByTestId("template-name").fill("A");
      await expect(create).toBeDisabled();
      await expect(page.locator("#create-template-reason")).toHaveText("Make the name at least two letters or digits long.");
      await page.getByTestId("template-name").fill("Ab");
      await expect(create).toBeEnabled();
    });

    test("review: a guide with --> stays inside its comment", async ({ page }) => {
      // protects=a guide that holds "-->" is written into the template as one comment, so none of
      // its words land in the body; fails_when=the arrow closes the comment early; no_claim=the API's check.
      await login(page);
      await page.goto("/settings/templates/new");
      await page.getByLabel("Section 1 guide").fill("Old flow --> new flow, in the customer's words.");
      await page.getByRole("button", { name: "Edit as Markdown" }).click();
      const md = page.getByLabel("Body", { exact: true });
      await expect(md).toHaveValue(/<!-- Old flow -> new flow, in the customer's words\. -->/);
      expect((await md.inputValue()).match(/-->/g)).toHaveLength(4);
    });
  });
}
