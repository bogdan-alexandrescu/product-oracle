import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The minors the first Nov 17 QA fix round left over, on the mock layer (invented data).
 * Desktop = 1440x900, phone = 390x844.
 *
 * Each test's card: protects=<the observable>; fails_when=<the wrong result>; no_claim=<what
 * green does not prove>.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

// protects=the Inbox's "Broken links" count (links) matches its rows: a row holding two says "· 2 links";
// fails_when=a folded row holds two links and nothing says so; no_claim=the fixes themselves.
test("Inbox broken links: a row holding more than one link says how many", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/inbox");
  const broken = page.getByTestId("inbox-broken-links");
  const rows = broken.getByTestId("waiting-item");
  await expect(rows.first()).toBeVisible();
  const total = Number(await broken.getByTestId("panel-count").first().textContent());
  const held = await rows.evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-breaks") ?? "1")));
  expect(held.reduce((a, b) => a + b, 0)).toBe(total);
  const many = rows.filter({ has: page.getByTestId("waiting-links") });
  await expect(many.first()).toBeVisible();
  for (const row of await rows.all()) {
    const n = Number(await row.getAttribute("data-breaks"));
    if (n > 1) await expect(row.getByTestId("waiting-links")).toHaveText(`· ${n} links`);
    else await expect(row.getByTestId("waiting-links")).toHaveCount(0);
  }
});

// protects=the agenda sheet's add chips read a feature's code with its name, or flag it;
// fails_when=a chip reads "+ Alert routing by team" with neither; no_claim=which code each feature has.
test("agenda sheet: a chip that adds a feature shows its code with its name", async ({ page, context }) => {
  await context.addInitScript((key) => localStorage.setItem(key, "meeting-agenda-sheet"), MOCK_SCENARIO_KEY);
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/meetings");
  await tap(page.getByRole("button", { name: /^Start review/ }).first());
  const start = page.getByRole("dialog", { name: "Start a review" });
  await start.getByLabel("PRD").selectOption({ label: "Usage alerts PRD" });
  await start.getByRole("checkbox", { name: "Theo Brandt" }).check();
  await tap(start.getByRole("button", { name: "Start", exact: true }));
  await tap(page.getByTestId("agenda-strip").getByRole("button", { name: "Edit agenda" }));
  const sheet = page.getByRole("dialog", { name: "Agenda" });
  const chips = sheet.getByRole("button", { name: /^\+ / });
  await expect(chips.first()).toBeVisible();
  for (const chip of await chips.all()) {
    await expect(chip).toHaveText(/^\+ (F-\d+[a-j]? \S.*|.*Not in the Ground Truth)$/);
  }
  await expect(sheet.getByRole("button", { name: /^\+ F-\d+[a-j]? Alert routing by team$/ })).toBeVisible();
});

// protects=on a phone, a toast at the bottom never covers the page's last button once scrolled to the end;
// fails_when=the last button stays under the toast; no_claim=the toast's own place on a desktop.
test("phone: the action toast leaves room, so the last buttons scroll clear of it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto("/simple/decisions");
  await tap(page.getByRole("button", { name: "Decide as recommended" }).first());
  const toast = page.getByTestId("toasts").getByRole("status");
  await expect(toast).toContainText("Decided");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const t = document.querySelector('[data-testid="toasts"] [role="status"]')!.getBoundingClientRect();
        const last = [...document.querySelectorAll("#main button, #main a[href]")]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 1 && r.height > 1)
          .sort((a, b) => b.bottom - a.bottom)[0]!;
        return last.bottom <= t.top;
      }),
    )
    .toBe(true);
});

// protects=a viewer's source rows name what resolves them ("Ask an owner"), not only "View only";
// fails_when=the row's only words are "View only"; no_claim=an owner's Edit.
test("a viewer's Inbox: a source that needs attention says to ask an owner", async ({ page }) => {
  await login(page, "viewer@example.com");
  await page.goto("/inbox");
  const list = page.getByTestId("inbox-sources");
  await expect(list).toBeVisible();
  await expect(list.getByTestId("need-by-role").first()).toHaveText("Ask an owner");
  await expect(list.getByText("View only", { exact: true })).toHaveCount(0);
});

// protects=Share as discussion fills its box once; what the person typed stays when the page reads again;
// fails_when=a read again (an action beside the page) puts the answer back over the typed text;
// no_claim=the prefill's own words.
test("Share as discussion: what the person typed stays when the page reads again", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/roadmap");
  await page.locator('[data-testid="simple-ask"], [data-testid="phone-ask"]').filter({ visible: true }).first().click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  const box = panel.getByRole("textbox", { name: "Message Oracle" });
  await box.fill("what is Weekly alert digest about?");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("ask-chat-thread").getByTestId("ask-answer").last()).toHaveAttribute("data-status", "complete", { timeout: 15_000 });
  await panel.getByTestId("ask-share").click();
  const first = panel.getByTestId("hop-share-form").getByLabel("First message");
  await expect(first).not.toHaveValue("");
  await first.fill("My own words for the team");
  // An action beside the page (an applied card, an Undo) has every page read again.
  await page.evaluate(() => window.dispatchEvent(new Event("po:data-changed")));
  await page.waitForTimeout(1500);
  await expect(first).toHaveValue("My own words for the team");
});

async function addDriveSource(page: Page) {
  await login(page);
  await page.goto("/settings/sources");
  const form = page.getByRole("form", { name: "Add a source" });
  await form.getByLabel("Kind").selectOption("google_docs");
  await form.getByLabel("Name").fill("Example Drive docs");
  return form;
}

// protects=the mock app's Choose from Drive opens a small picker of example docs a person can finish;
// fails_when=it loads Google's real sign-in (refused for the mock's client id); no_claim=the real picker.
test("mock app: Choose from Drive opens a picker of example docs", async ({ page }) => {
  const asked: string[] = [];
  await page.route(/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|gstatic\.com)\//, (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  const form = await addDriveSource(page);
  await form.getByRole("button", { name: "Choose from Drive" }).click();
  const picker = page.getByRole("dialog", { name: "Choose Google Docs and folders" });
  await expect(picker).toBeVisible();
  await picker.getByRole("checkbox", { name: "Roadmap notes" }).check();
  await picker.getByRole("checkbox", { name: "Product specs (folder)" }).check();
  await picker.getByRole("button", { name: "Select" }).click();
  await expect(picker).toHaveCount(0);
  const picked = form.getByRole("list", { name: "Picked files and folders" }).getByRole("listitem");
  await expect(picked).toHaveCount(2);
  await expect(picked.filter({ hasText: "Roadmap notes" })).toBeVisible();
  await expect(picked.filter({ hasText: "Product specs" })).toBeVisible();
  expect(asked).toEqual([]);
});

/** The text fits its box: nothing is cut with "…". */
async function whole(l: Locator) {
  await expect(l).toBeVisible();
  expect(await l.evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1)).toBe(true);
}

// protects=Simple's Inbox "For" cells (an access request's quote, a proposal's run) wrap rather than cut at 1440;
// fails_when=either reads with "…" while the row has room; no_claim=a text longer than two lines.
test("Simple Inbox at 1440: the For cells wrap, never cut on one line", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto("/simple/inbox");
  const needs = page.getByTestId("inbox-needs");
  await whole(needs.locator('span[title="I lead support and need to read the PRD."]').first());
  await whole(needs.locator(".truncate", { hasText: /Ground Truth proposal · Team onboarding/ }).last());
});
