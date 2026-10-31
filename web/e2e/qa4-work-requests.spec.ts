import { expect, test, type Page } from "./test";

import { MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * QA findings on Requests (qa4-work-13 … qa4-work-21): the page drawing at once, the queue's
 * header and rows, a search with no match, /requests/new, one word for the person who asked,
 * Reopen only where it acts, and the phone's request cards. Driven through the UI on the mock
 * API, at desktop (1440x900) and phone (390x844) width.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** From the rail, as a person gets there. */
async function openRequests(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) > 600) await page.getByTestId("nav-requests").filter({ visible: true }).first().click();
  else {
    // A phone: Requests is under the tab bar's More.
    await page.getByTestId("tab-bar").getByTestId("tab-more").click();
    await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Requests" }).click();
  }
  await expect(page).toHaveURL(/\/requests$/);
  await expect(page.getByRole("heading", { name: "Requests", level: 1 })).toBeAttached();
}

const rows = (page: Page) => page.getByTestId("request-row");
const row = (page: Page, title: string) => rows(page).filter({ has: page.getByRole("button", { name: title, exact: true }) });
const inspector = (page: Page) => page.getByTestId("request-inspector");
const tab = (page: Page, id: "all" | "new") => page.getByTestId(`requests-tab-${id}`).filter({ visible: true });

for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test(`qa4-work-13: the list does not jump when the owner's controls and Oracle's finds load (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await login(page);
    // What the role may do answers slowly, as on a slow connection.
    await page.evaluate(
      ([slow, ms, path]) => {
        localStorage.setItem(slow, path);
        localStorage.setItem(ms, "2500");
      },
      [MOCK_SLOW_KEY, MOCK_SLOW_MS_KEY, "/v1/me/capabilities"] as const,
    );
    // Opened fresh, as the finding's steps say.
    await page.goto("/requests");
    // While it loads, a placeholder holds the place; no rows yet.
    await expect(page.getByTestId("requests-loading")).toBeVisible();
    await expect(rows(page)).toHaveCount(0);

    const first = rows(page).first();
    await expect(first).toBeVisible({ timeout: 15_000 });
    const before = (await first.boundingBox())!;
    // The owner's controls and Oracle's finds are there with the list, not after it.
    await expect(page.getByRole("button", { name: "New request" }).filter({ visible: true })).toBeVisible();
    await expect(page.getByTestId("found-in-sources")).toBeVisible();
    await expect(page.getByTestId("found-in-sources")).toContainText("Oracle found 2 possible requests");
    await page.waitForTimeout(500);
    const after = (await first.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    await expect(page.getByTestId("requests-loading")).toHaveCount(0);
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa4-work-15: one line of headers, each over its column's values, and a one-line PRD box header", async ({ page }) => {
    await login(page);
    await openRequests(page);
    const head = page.getByTestId("request-list-head");
    const choose = page.getByTestId("request-list-head-choose");
    await expect(choose).toHaveText("PRD");
    await expect(head.getByText("Request", { exact: true })).toHaveCount(0);
    const chooseBox = (await choose.boundingBox())!;
    // One line: "PRD" does not wrap, and every header sits on the same line as it.
    expect(chooseBox.height).toBeLessThan(20);
    const first = rows(page).first();
    const box = (await first.getByTestId("request-choose").boundingBox())!;
    expect(Math.abs(chooseBox.x + chooseBox.width / 2 - (box.x + box.width / 2))).toBeLessThan(2);
    for (const [key, label] of [
      ["state", "State"],
      ["goal", "Goal"],
      ["theme", "Theme"],
      ["asker", "Asked by"],
      ["channel", "Channel"],
      ["age", "Age"],
    ] as const) {
      const h = (await head.getByText(label, { exact: true }).boundingBox())!;
      const cell = (await first.locator(`[data-field=${key}]`).boundingBox())!;
      expect(Math.abs(h.x - cell.x), label).toBeLessThan(2);
      expect(Math.abs(h.y - chooseBox.y), label).toBeLessThan(2);
    }
  });

  test("qa4-work-16: two state tags sit side by side, so rows keep one height", async ({ page }) => {
    await login(page);
    await openRequests(page);
    for (const title of ["Pay by bank transfer", "A custom domain for the shop"]) {
      const chips = row(page, title).getByTestId("request-state").locator(":scope > span");
      await expect(chips).toHaveCount(2);
      await expect(chips.nth(1)).toHaveText("Unverified");
      const [a, b] = [(await chips.nth(0).boundingBox())!, (await chips.nth(1).boundingBox())!];
      expect(Math.abs(a.y - b.y), title).toBeLessThan(1);
      expect(b.x, title).toBeGreaterThan(a.x + a.width);
    }
    // A New + Unverified row is as tall as a New row with one tag.
    const two = (await row(page, "Pay by bank transfer").boundingBox())!;
    const one = (await row(page, "Dark mode").boundingBox())!;
    expect(Math.abs(two.height - one.height)).toBeLessThan(1);
  });

  test("qa4-work-17: a search with no match offers Clear search, and the inspector says its request is hidden", async ({ page }) => {
    await login(page);
    await openRequests(page);
    await row(page, "Bulk edit prices").getByRole("button", { name: "Bulk edit prices", exact: true }).click();
    await expect(inspector(page)).toContainText("Bulk edit prices");
    await page.getByLabel("Search requests").fill("zzzz");
    const none = page.getByTestId("requests-no-match");
    await expect(none).toContainText("No requests match your search");
    await expect(page.getByTestId("request-hidden")).toHaveText(/Your search hides this request from the list\./);
    await none.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByLabel("Search requests")).toHaveValue("");
    await expect(row(page, "Bulk edit prices")).toBeVisible();
    await expect(page.getByTestId("request-hidden")).toHaveCount(0);
    await expect(none).toHaveCount(0);

    // The note's own Clear search brings the request back too.
    await page.getByLabel("Search requests").fill("zzzz");
    await page.getByTestId("request-hidden").getByRole("button", { name: "Clear search" }).click();
    await expect(row(page, "Bulk edit prices")).toHaveAttribute("aria-current", "true");
  });

  test("qa4-work-18: /requests/new opens New request over All requests, not To decide", async ({ page }) => {
    await login(page);
    await openRequests(page);
    await expect(tab(page, "all")).toHaveAttribute("aria-current", "page");
    await page.goto("/requests/new");
    const dialog = page.getByRole("dialog", { name: "New request" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/requests\?compose=request$/);
    await expect(tab(page, "all")).toHaveAttribute("aria-current", "page");
    // Reloaded with the form open, it is still over All requests.
    await page.reload();
    await expect(dialog).toBeVisible();
    await expect(tab(page, "all")).toHaveAttribute("aria-current", "page");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/requests$/);
  });

  test("qa4-work-19: the form, the table and the inspector all say 'Asked by'", async ({ page }) => {
    await login(page);
    await openRequests(page);
    await expect(page.getByTestId("request-list-head")).toContainText("Asked by");
    await row(page, "Bulk edit prices").getByRole("button", { name: "Bulk edit prices", exact: true }).click();
    await expect(inspector(page).getByTestId("request-asked-by")).toHaveText("Asked by A shop owner");
    await expect(inspector(page).getByText("From A shop owner")).toHaveCount(0);
    await page.getByRole("button", { name: "New request" }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New request" });
    await expect(dialog.getByLabel("Asked by")).toHaveValue("Admin");
    await expect(dialog.getByText("Requester", { exact: true })).toHaveCount(0);
  });

  test("qa4-work-20: Reopen shows only on a merged or disqualified request", async ({ page }) => {
    await login(page);
    await openRequests(page);
    await row(page, "Bulk edit prices").getByRole("button", { name: "Bulk edit prices", exact: true }).click();
    await expect(inspector(page).getByRole("button", { name: "Qualify", exact: true })).toBeVisible();
    await expect(inspector(page).getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
    await row(page, "Weekly summary email").getByRole("button", { name: "Weekly summary email", exact: true }).click();
    await expect(inspector(page)).toContainText("Weekly summary email");
    await expect(inspector(page).getByRole("button", { name: "Reopen", exact: true })).toHaveCount(0);
    await row(page, "A custom domain for the shop").getByRole("button", { name: "A custom domain for the shop", exact: true }).click();
    await expect(inspector(page).getByRole("button", { name: "Reopen", exact: true })).toBeEnabled();
  });
});

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa4-work-21: a request card shows one field per row, short values on one line", async ({ page }) => {
    await login(page);
    await openRequests(page);
    const cards = [row(page, "Bulk edit prices"), row(page, "Keep the delivery address between orders")];
    for (const card of cards) {
      await card.scrollIntoViewIfNeeded();
      // One field per row: every field starts at the same x, each below the one before.
      const boxes = await card.locator("[data-field]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })));
      expect(boxes).toHaveLength(6);
      for (let i = 1; i < boxes.length; i++) {
        expect(Math.abs(boxes[i].x - boxes[0].x)).toBeLessThan(1);
        expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
      }
    }
    // Short values stay on one line: "A shop owner", "Faster check-out" and the goal chips.
    const lines = await page.getByTestId("request-list").evaluate((list) => {
      const out: { text: string; lines: number }[] = [];
      const els = list.querySelectorAll<HTMLElement>("[data-field=asker] [title], [data-field=theme] [title], [data-testid=goal-chip]");
      for (const el of els) {
        const text = el.textContent ?? "";
        if (text.length > 20) continue;
        const style = getComputedStyle(el);
        const lh = parseFloat(style.lineHeight) || 20;
        const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        out.push({ text, lines: Math.round((el.getBoundingClientRect().height - pad) / lh) });
      }
      return out;
    });
    expect(lines.map((l) => l.text)).toEqual(expect.arrayContaining(["A shop owner", "Faster check-out"]));
    for (const l of lines) expect(l, l.text).toEqual({ text: l.text, lines: 1 });
  });
});
