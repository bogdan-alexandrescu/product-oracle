import { expect, test, type Locator, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA round 3 on /inbox and Home's Needs you (Detailed):
 * - qa-company-1: a cost approval asks first, naming the amount, on Home and in the Inbox, and
 *   says what it did.
 * - qa-company-3: an "Oracle asks" row shows its question once: no "Show the text" that only
 *   repeats it, and the answer form does not repeat it either.
 * - qa-company-4: on a phone a Comment row's actions keep one line.
 * - qa-company-7: an "Oracle asks" row's Open is outlined, as every other row's Open.
 * - qa-company-15: a comment cut with "…" gives its full text on hover.
 * - qa-company-16: the panel's heading and count follow the tab; Staged's row has an age.
 * - qa-company-17: back on the Inbox, an emptied New does not stay open over Seen.
 * - qa-company-18: an access request's Approve is outlined, as other rows' first action.
 * - qa-company-19: on a phone an access request's role and buttons line up with its text.
 * - qa-company-20: a source's reason wraps rather than being cut mid-sentence.
 * - qa-onboarding-27: Needs you names a decision by its title, never its bare code.
 */

const QUESTION = "Which metric shows repeat checkout got faster?";
const METRIC = "Add a metric that shows the outbound check works";
const NEW_PERSON = "new.person@example.com";

const tabs = (page: Page) => page.getByTestId("inbox-state-tabs");
const tab = (page: Page, name: string) => tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });
const notice = (page: Page) => page.getByTestId("inbox-acted");
const homeLines = (page: Page) => page.getByTestId("home-needs-table").locator("tr[data-row]");
const scenario = (page: Page, name: string) => page.addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, name] as const);
const rail = (page: Page) => page.getByRole("navigation", { name: "Oracle" });

async function openInbox(page: Page) {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(tabs(page)).toBeVisible();
}

async function openHome(page: Page) {
  await page.goto("/home");
  await expect(homeLines(page).first()).toBeVisible();
}

/** The Oracle asks row, on Home or in the Inbox's shown tab. */
function questionRow(page: Page, where: "home" | "inbox"): Locator {
  const rows = where === "home" ? homeLines(page) : page.locator("[role=tabpanel]").getByTestId("inbox-questions").locator("tr[data-row]");
  return rows.filter({ hasText: QUESTION });
}

/** Clicks a cost approval's Approve and checks the question names the amount; `yes` approves. */
async function approveCost(page: Page, row: Locator, yes: boolean) {
  await row.getByRole("button", { name: "Approve $53.00" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Approve $53.00");
  await expect(dialog).toContainText("$53.00");
  await dialog.getByRole("button", { name: yes ? "Approve $53.00" : "Back" }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-company-1: Home's cost Approve asks first, naming the amount, then says the run started", async ({ page }) => {
    await login(page);
    await openHome(page);
    const approval = homeLines(page).filter({ hasText: "$53.00 est." });
    await approveCost(page, approval, false);
    // Back: nothing approved.
    await expect(approval).toHaveCount(1);
    await approveCost(page, approval, true);
    await expect(notice(page)).toContainText("Approved: run started");
    await expect(homeLines(page).filter({ hasText: "$53.00 est." })).toHaveCount(0);
  });

  test("qa-company-1: the Inbox's cost Approve asks the same, then says the run started", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const approval = page.getByTestId("inbox-approvals").locator("tr[data-row]").filter({ hasText: "$53.00" });
    await approveCost(page, approval, false);
    await expect(approval).toHaveCount(1);
    await approveCost(page, approval, true);
    await expect(notice(page)).toContainText("Approved: run started");
    await expect(page.getByTestId("inbox-approvals")).toHaveCount(0);
  });

  for (const where of ["home", "inbox"] as const) {
    test(`qa-company-3: on ${where === "home" ? "Home" : "the Inbox"} an Oracle asks row shows its question once`, async ({ page }) => {
      await login(page);
      if (where === "home") await openHome(page);
      else await openInbox(page);
      const row = questionRow(page, where);
      await expect(row).toContainText("Oracle asks");
      // No chevron whose text only repeats the row's.
      await expect(row.getByRole("button", { name: "Show the text" })).toHaveCount(0);
      await row.getByRole("button", { name: "Answer" }).click();
      const form = page.getByTestId("answer-question");
      await expect(form.getByLabel("Your answer")).toBeVisible();
      await expect(form.getByTestId("answer-prompt")).toHaveCount(0);
      await expect(page.getByTestId("need-quote")).toHaveCount(0);
      // The question is on screen once: in its row.
      const needs = page.getByTestId(where === "home" ? "home-needs" : "inbox-needs");
      await expect(needs.getByText(QUESTION, { exact: true }).filter({ visible: true })).toHaveCount(1);
    });
  }

  test("qa-company-7: an Oracle asks row's Open is outlined, as every other row's Open", async ({ page }) => {
    await login(page);
    await openHome(page);
    const open = questionRow(page, "home").getByRole("link", { name: /^Open/ });
    await expect(open).toHaveAttribute("data-variant", "secondary");
    const others = homeLines(page).filter({ hasNotText: QUESTION }).getByRole("link", { name: /^Open/ });
    for (const variant of await others.evaluateAll((els) => els.map((e) => e.getAttribute("data-variant")))) expect(variant).toBe("secondary");
    await openInbox(page);
    await expect(questionRow(page, "inbox").getByRole("link", { name: /^Open/ })).toHaveAttribute("data-variant", "secondary");
  });

  test("qa-company-15: a comment cut with an ellipsis shows its full text on hover", async ({ page }) => {
    await scenario(page, "suggestions");
    await login(page);
    await openInbox(page);
    const links = page.locator("[role=tabpanel]").getByTestId("inbox-feedback").locator("tr[data-row] td:nth-child(2) a");
    await expect(links.first()).toBeVisible();
    let cut = 0;
    for (const link of await links.all()) {
      const isCut = await link.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      if (!isCut) continue;
      cut += 1;
      const full = (await link.textContent())!.trim();
      const title = await link.getAttribute("title");
      if (title) {
        expect(title).toBe(full);
        continue;
      }
      await link.hover();
      await expect(page.getByTestId("suggestion-peek-summary").filter({ visible: true })).toHaveText(full);
      await page.mouse.move(0, 0);
    }
    expect(cut).toBeGreaterThan(0);
  });

  test("qa-company-16: the heading and count follow the tab, and Staged's row has an age", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const panel = page.getByTestId("inbox-needs");
    const heading = panel.locator("h2").first();
    const count = panel.getByTestId("panel-count").first();
    const tabCount = async (name: string) => Number((await tab(page, name).innerText()).replace(/\D+/g, "") || "0");
    await expect(heading).toHaveText("Needs you");
    for (const name of ["Staged", "Declined", "Done"]) {
      await tab(page, name).click();
      await expect(heading).toHaveText(name);
      await expect(count).toHaveText(String(await tabCount(name)));
    }
    await tab(page, "Staged").click();
    const next = page.getByTestId("inbox-tab-staged").locator("tr[data-row]").filter({ has: page.getByTestId("staged-row-label") });
    await expect(next.locator("td").nth(3)).toHaveText(/\S/);
    await tab(page, "New").click();
    await expect(heading).toHaveText("Needs you");
  });

  test("qa-company-17: back on the Inbox, it opens on Seen once New has emptied", async ({ page }) => {
    await login(page);
    await openInbox(page);
    // The person looks at New on purpose, then leaves for Home.
    await tab(page, "New").click();
    await expect(tab(page, "New")).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("po-mock-db-v2") ?? "{}").inbox_seen ?? {}).length))
      .toBeGreaterThan(0);
    await rail(page).getByRole("link", { name: /^Home/ }).click();
    await expect(page).toHaveURL(/\/home$/);
    await rail(page).getByRole("link", { name: /^Inbox/ }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    // Everything waiting is in Seen now: the Inbox opens there, not on an empty New.
    await expect(tab(page, "Seen").filter({ visible: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("inbox-tab-empty").filter({ visible: true })).toHaveCount(0);
  });

  test("qa-company-18: an access request's Approve is outlined like other rows' first action", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const row = page.locator("[role=tabpanel]").getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
    await expect(row.getByRole("button", { name: "Approve", exact: true })).toHaveAttribute("data-variant", "secondary");
    await expect(row.getByRole("button", { name: "Decline", exact: true })).toHaveAttribute("data-variant", "ghost");
  });

  test("qa-company-20: a source's reason wraps rather than being cut mid-sentence", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const text = page.getByTestId("inbox-sources").getByText(/^Allowlist at most 100 channels/);
    await expect(text).toBeVisible();
    const [overX, overY] = await text.evaluate((el) => [el.scrollWidth > el.clientWidth + 1, el.scrollHeight > el.clientHeight + 1]);
    expect(overX).toBe(false);
    expect(overY).toBe(false);
  });

  test("qa-onboarding-27: an approver's Needs you names a decision by its title, not its code", async ({ page }) => {
    await login(page, "approver@example.com");
    await openInbox(page);
    const decision = page.locator("[role=tabpanel]").getByTestId("inbox-decisions").locator("tr[data-row]").filter({ hasText: "Ship usage caps before anomaly detection" });
    await expect(decision).toContainText("Decision needs you · Ship usage caps before anomaly detection");
    await expect(decision).not.toContainText(/\bD-\d+/);
    await openHome(page);
    const lines = homeLines(page).filter({ hasText: /Decision needs you|Review due/ });
    for (const text of await lines.allInnerTexts()) expect(text).not.toMatch(/\bD-\d+/);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-company-4: a Comment row's Accept, Decline and Open keep one line", async ({ page }) => {
    await scenario(page, "suggestions");
    await login(page);
    await openInbox(page);
    const row = page.getByTestId("inbox-tab-new").getByTestId("inbox-feedback").locator("tr[data-row]").filter({ hasText: METRIC });
    const accept = row.getByRole("button", { name: "Accept", exact: true });
    await expect(accept).toBeVisible();
    const boxes = await Promise.all(
      [accept, row.getByRole("button", { name: "Decline", exact: true }), row.getByRole("link", { name: `Open ${METRIC}` })].map(async (l) => (await l.boundingBox())!),
    );
    const width = (await row.boundingBox())!.width;
    for (const b of boxes) {
      expect(Math.abs(b.y - boxes[0].y)).toBeLessThan(4);
      expect(b.width).toBeLessThan(width / 2);
    }
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
    expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("qa-company-19: an access request's role and buttons line up with its text", async ({ page }) => {
    await login(page);
    await openInbox(page);
    const row = page.locator("[role=tabpanel]").getByTestId("inbox-access-requests").locator("tr[data-row]").filter({ hasText: NEW_PERSON });
    const email = (await row.getByText(`${NEW_PERSON} asks to join`).boundingBox())!;
    const select = (await row.getByRole("combobox", { name: `Role for ${NEW_PERSON}` }).boundingBox())!;
    const approve = (await row.getByRole("button", { name: "Approve", exact: true }).boundingBox())!;
    expect(Math.abs(select.x - email.x)).toBeLessThan(6);
    expect(approve.x).toBeGreaterThan(select.x);
    expect(Math.abs(approve.y - select.y)).toBeLessThan(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
