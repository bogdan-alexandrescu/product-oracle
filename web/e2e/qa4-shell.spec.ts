import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/**
 * QA pass 4, the app shell: the phone's Ask sheet over the tab bar (qa4-shell-1), failed list
 * loads (qa4-shell-2, 3, 18, 21), missing meetings, templates and reports (qa4-shell-4), the
 * mode switch (qa4-shell-5, 6), the Ask drawer (qa4-shell-9, 12), browser-tab titles
 * (qa4-shell-13, 14), loading bars (qa4-shell-19), Runs' header (qa4-shell-20) and the phone's
 * More tab (qa4-shell-22).
 */
const PHONE = { width: 390, height: 844 };

/** Makes the mock's GETs of `path` fail (500) from the next page load on. */
async function failGets(page: Page, path: string) {
  await page.evaluate((p) => localStorage.setItem("po-mock-fail", p), path);
}

async function stopFailing(page: Page) {
  await page.evaluate(() => localStorage.removeItem("po-mock-fail"));
}

/** Whether a tap at the middle of `l` lands on it (nothing drawn over it). */
async function tappable(l: Locator) {
  return l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && (hit === el || el.contains(hit)) && r.bottom <= window.innerHeight;
  });
}

const modeSwitch = (page: Page, mode: "Simple" | "Detailed") =>
  page.getByRole("radiogroup", { name: "Mode" }).filter({ visible: true }).getByRole("radio", { name: mode });

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-shell-1: on a phone in Detailed, Ask's text box sits over the tab bar, and a tap types in it", async ({ page }) => {
    await login(page);
    for (const path of ["/home", "/documents"]) {
      await page.goto(path);
      await page.getByTestId("phone-ask").click();
      const sheet = page.getByTestId("phone-ask-sheet");
      const box = sheet.getByRole("textbox", { name: "Ask Oracle" });
      await expect(box).toBeVisible();
      expect(await tappable(box), `${path}: the box`).toBe(true);
      expect(await tappable(sheet.getByRole("button", { name: "Send" })), `${path}: Send`).toBe(true);
      await box.click();
      await page.keyboard.type("What should we cut first?");
      await expect(box).toHaveValue("What should we cut first?");
      await page.keyboard.press("Escape");
    }
  });

  test("qa4-shell-22: the More tab is marked current on a More page", async ({ page }) => {
    await login(page);
    const more = page.getByTestId("tab-more");
    await expect(more).not.toHaveAttribute("aria-current");
    await page.goto("/priorities");
    await expect(more).toHaveAttribute("aria-current", "page");
    await page.goto("/settings/members");
    await expect(more).toHaveAttribute("aria-current", "page");
    await page.goto("/documents");
    await expect(more).not.toHaveAttribute("aria-current");
  });
});

test("qa4-shell-2, 3: PRDs that fail to load show the error and Try again only, no empty state or counts", async ({ page }) => {
  await login(page);
  await failGets(page, "/v1/documents");
  await page.goto("/documents");
  const error = page.getByTestId("load-error");
  await expect(error).toContainText("Couldn't load your PRDs.");
  await expect(page.getByTestId("table-empty")).toHaveCount(0);
  await expect(page.getByTestId("prds-empty")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Show" })).toHaveCount(0);
  await stopFailing(page);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("load-error")).toHaveCount(0);
  await expect(page.getByTestId("document-row").first()).toBeVisible();
});

test("qa4-shell-2, 3, 21: Runs that fail to load show the error and Try again only, no empty table", async ({ page }) => {
  await login(page);
  await failGets(page, "/v1/runs");
  await page.goto("/runs");
  const error = page.getByTestId("load-error");
  await expect(error).toContainText("Couldn't load your runs.");
  await expect(page.getByTestId("runs-table")).toHaveCount(0);
  await expect(page.getByText("Nothing yet")).toHaveCount(0);
  await stopFailing(page);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("run-row").first()).toBeVisible();
});

test("qa4-shell-3: an Inbox that fails to load says so plainly, with Try again", async ({ page }) => {
  await login(page);
  await failGets(page, "/v1/inbox");
  await page.goto("/inbox");
  const error = page.getByTestId("load-error");
  await expect(error).toContainText("Couldn't load your inbox.");
  await stopFailing(page);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("load-error")).toHaveCount(0);
});

test("qa4-shell-21: the error has the page's spacing above the next block (the Ideas list's)", async ({ page }) => {
  await login(page);
  await failGets(page, "/v1/intakes");
  await page.goto("/documents");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /^Ideas/ }).click();
  const error = page.getByTestId("load-error");
  await expect(error).toContainText("Couldn't load the ideas.");
  // Nothing below it pretends the list is empty.
  await expect(page.getByTestId("ideas-empty")).toHaveCount(0);
  const marginBottom = await error.evaluate((el) => getComputedStyle(el.parentElement!).marginBottom);
  expect(marginBottom).toBe("16px");
});

test("qa4-shell-18, 19: while PRDs load, no count shows and the loading bars can be seen", async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    localStorage.setItem("po-mock-slow", "/v1/documents");
    localStorage.setItem("po-mock-slow-ms", "4000");
  });
  await page.goto("/documents");
  const show = page.getByRole("group", { name: "Show" });
  await expect(show.getByRole("button", { name: "Ideas", exact: true })).toBeVisible();
  await expect(show.locator("b")).toHaveCount(0);
  const bar = page.getByTestId("documents-table").locator("tbody tr[aria-hidden] span").first();
  await expect(bar).toBeVisible();
  // line-strong (#7d8ea3), about 3.3:1 on the white card; surface2 was all but invisible.
  await expect(bar).toHaveCSS("background-color", "rgb(125, 142, 163)");
  await expect(page.getByTestId("document-row").first()).toBeVisible({ timeout: 10_000 });
  await expect(show.locator("b")).toHaveCount(2);
});

test("qa4-shell-4: a missing meeting, template or report gets the not-found page", async ({ page }) => {
  await login(page);
  for (const [path, title, text, back] of [
    ["/company/rituals/zzz", "Meeting not found", "This meeting doesn't exist or was deleted.", "Back to Rituals"],
    ["/settings/templates/zzz", "Template not found", "This template doesn't exist or was deleted.", "Back to Templates"],
    ["/plan/reports/zzz", "Report not found", "This report doesn't exist or was deleted.", "Back to Reports"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: title }), path).toBeVisible();
    await expect(page.getByTestId("not-found-text")).toHaveText(text);
    await expect(page.getByRole("link", { name: back })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Home" })).toBeVisible();
    await expect(page.getByText("Occurrence not found")).toHaveCount(0);
    await expect(page).toHaveTitle(new RegExp(`^${title}`));
  }
});

test("qa4-shell-5: Simple from New roadmap opens Simple's Roadmap", async ({ page }) => {
  await login(page);
  await page.goto("/documents/new?kind=roadmap");
  await modeSwitch(page, "Simple").click();
  await expect(page).toHaveURL(/\/simple\/roadmap$/);
});

test("qa4-shell-6: Detailed to Simple and straight back returns to the page left", async ({ page }) => {
  await login(page);
  for (const path of ["/requests", "/plan/dates"]) {
    await page.goto(path);
    await modeSwitch(page, "Simple").click();
    await expect(page).toHaveURL(/\/simple(\/|$)/);
    await modeSwitch(page, "Detailed").click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
});

test("qa4-shell-9: in dark, the page behind the Ask drawer is dimmed", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await login(page);
  await page.goto("/documents");
  await page.getByTestId("hop-strip").click();
  await expect(page.getByTestId("hop-backdrop")).toHaveCSS("background-color", "rgba(0, 0, 0, 0.55)");
});

test("qa4-shell-12: under your own message Edit, Delete and Research this sit on one line", async ({ page }) => {
  await login(page);
  await page.goto("/documents");
  await page.getByTestId("hop-strip").click();
  const panel = page.getByTestId("hop-panel").filter({ visible: true });
  await panel.getByRole("textbox", { name: "Ask Oracle" }).fill("Why is checkout first?");
  await panel.getByRole("button", { name: "Send" }).click();
  const mine = panel.getByTestId("discussion-message").filter({ hasText: "Why is checkout first?" });
  const tops = await Promise.all(
    ["Edit message", "Delete message", "Research this"].map(async (name) => {
      const button = mine.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      return (await button.boundingBox())!.y;
    }),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
});

test("qa4-shell-13: Settings pages say Settings, on the page and in the browser tab", async ({ page }) => {
  await login(page);
  await page.goto("/settings/members");
  await expect(page.getByTestId("settings-eyebrow")).toHaveText("Settings");
  await expect(page).toHaveTitle("Members · Settings · Product Oracle");
});

test("qa4-shell-14: Simple's pages are told apart from Detailed's in the browser tab", async ({ page }) => {
  await login(page);
  await expect(page).toHaveTitle("Home · Product Oracle");
  await page.goto("/simple");
  await expect(page).toHaveTitle("Home · Simple · Product Oracle");
  await page.goto("/simple/priorities");
  await expect(page).toHaveTitle("Priorities · Simple · Product Oracle");
});
