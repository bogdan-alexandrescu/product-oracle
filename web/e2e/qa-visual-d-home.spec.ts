import { expect, test, type Page } from "./test";

import { MOCK_FAIL_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

/*
 * Visual QA pass D on Detailed's Home (mock build, invented data).
 *
 * Test cards (protects / fails_when / no_claim):
 * - D-1: protects=a failed PRDs or runs load in In flight says so with Try again, and no empty
 *   line or table shows; fails_when=the server's words show bare, then "Nothing in flight".
 * - D-2: protects=Needs you's chips add up to its total for an owner, an approver and a
 *   commenter, and each opens the Inbox on its kind; fails_when=a counted kind has no chip.
 * - D-3: protects=at 1440 with four goals in a row, a goal's target never draws over its
 *   confidence line; fails_when=their boxes overlap.
 * - D-5: protects=each blocker of the selected PRD links to the blocker, Resolve for a role
 *   that can, Open for a reader; fails_when=the row is plain text.
 * - D-6: protects=on a phone a Set up row's name and status are whole, stacked; fails_when=
 *   either is cut mid-word.
 * - D-7: protects=a failed setup load shows Try again where Set up goes, for a role that sees
 *   Set up; fails_when=the card just goes missing. no_claim=the API's setup steps.
 */

async function openHome(page: Page, role?: "viewer" | "commenter" | "approver") {
  await login(page, role ? `${role}@example.com` : undefined);
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeAttached();
}

async function failing(page: Page, path: string) {
  await page.addInitScript(([k, p]) => localStorage.setItem(k, p), [MOCK_FAIL_KEY, path] as const);
}

async function stopFailing(page: Page) {
  await page.evaluate((k) => localStorage.removeItem(k), MOCK_FAIL_KEY);
}

for (const path of ["/v1/runs", "/v1/documents"]) {
  test(`D-1: In flight says it could not load (${path}) and Try again loads it`, async ({ page }) => {
    await failing(page, path);
    await openHome(page);
    const flight = page.getByTestId("home-in-flight");
    const error = flight.getByTestId("load-error");
    await expect(error).toContainText("Couldn't load what's in flight.");
    await expect(flight.getByTestId("home-in-flight-empty")).toHaveCount(0);
    await expect(flight.getByTestId("home-in-flight-table")).toHaveCount(0);
    await expect(flight).not.toContainText("Nothing in flight");
    await stopFailing(page);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(flight.getByTestId("load-error")).toHaveCount(0);
    await expect(flight.getByTestId("flight-row").first()).toBeVisible();
  });
}

for (const role of [undefined, "approver", "commenter"] as const) {
  test(`D-2: Needs you's chips add up to its total (${role ?? "owner"}), each opening its kind in the Inbox`, async ({ page }) => {
    await openHome(page, role);
    const needs = page.getByTestId("home-needs");
    // The total shows once the Inbox has loaded: the header's "N waiting", absent at zero.
    await expect(needs.getByTestId("home-inbox-link")).toBeVisible();
    const waiting = page.getByText(/^\d+ waiting$/);
    const chips = needs.getByTestId("home-needs-counts").locator("[data-testid^='home-count-']");
    const read = async () => {
      const total = (await waiting.count()) ? Number((await waiting.first().textContent())!.split(" ")[0]) : 0;
      const counts = await chips.evaluateAll((els) => els.map((el) => Number(el.querySelector("b")?.textContent ?? "0")));
      return { total, sum: counts.reduce((a, b) => a + b, 0), counts };
    };
    await expect(needs.getByTestId("home-needs-table").or(needs.getByTestId("home-needs-empty")).first()).toBeVisible();
    await expect.poll(async () => { const r = await read(); return r.sum - r.total; }, { timeout: 8000 }).toBe(0);
    const { total, counts } = await read();
    if (total === 0) return;
    const first = chips.first();
    const href = await first.getAttribute("href");
    expect(href).toMatch(/^\/inbox\?kind=[a-z]+$/);
    const n = counts[0];
    await first.click();
    await expect(page).toHaveURL(href!);
    const filter = page.getByTestId("inbox-kind");
    await expect(filter).toBeVisible();
    await expect(page.getByTestId("inbox-needs")).toContainText(String(n));
    await filter.getByRole("link", { name: "Show all" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  });
}

test("D-2: the Approvals chip opens the Inbox on approvals only", async ({ page }) => {
  await openHome(page);
  const approvals = page.getByTestId("home-needs").getByTestId("home-count-approvals");
  await expect(approvals).toHaveText("Approvals 3");
  await approvals.click();
  await expect(page).toHaveURL(/\/inbox\?kind=approvals$/);
  await expect(page.getByTestId("inbox-kind")).toContainText("Approvals");
  await expect(page.getByTestId("inbox-feedback")).toHaveCount(0);
  await expect(page.getByTestId("inbox-decisions")).toHaveCount(0);
});

test.describe("at 1440", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ["light", "dark"]) {
    test(`D-3: with four goals in a row a target never draws over its confidence line (${theme})`, async ({ page }) => {
      await page.addInitScript(([k, t]) => {
        localStorage.setItem(k, "large");
        localStorage.setItem("oracle-theme", t);
      }, [MOCK_SCENARIO_KEY, theme] as const);
      await openHome(page);
      const cards = page.locator("[data-testid^='home-goal-G']");
      await expect(cards.first().getByTestId("goal-figure")).toBeVisible();
      const confidences = page.locator("[data-testid^='home-goal-G'] [data-testid='goal-confidence']");
      await expect(confidences.first()).toBeVisible();
      const overlaps = await cards.evaluateAll((els) =>
        els.flatMap((card) => {
          const fig = card.querySelector("[data-testid='goal-figure']");
          const conf = card.querySelector("[data-testid='goal-confidence']");
          if (!fig || !conf) return [];
          const c = conf.getBoundingClientRect();
          return [...fig.children].flatMap((part) => {
            const r = part.getBoundingClientRect();
            const hit = r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom;
            return hit ? [`${card.getAttribute("data-testid")}: "${part.textContent}"`] : [];
          });
        }),
      );
      expect(overlaps).toEqual([]);
    });
  }

  test("D-5: each blocker of the selected PRD opens the blocker, Resolve for an owner", async ({ page }) => {
    await openHome(page);
    const blocker = page.getByTestId("home-inspector").getByTestId("inspector-blocker").first();
    await expect(blocker).toBeVisible();
    const resolve = blocker.getByRole("link", { name: /^Resolve/ });
    await expect(resolve).toHaveAttribute("href", /^\/baseline\?tab=blockers&blocker=/);
    await resolve.click();
    await expect(page).toHaveURL(/\/baseline\?tab=blockers&blocker=/);
  });

  test("D-5: a viewer's blocker row says Open", async ({ page }) => {
    await openHome(page, "viewer");
    const blocker = page.getByTestId("home-inspector").getByTestId("inspector-blocker").first();
    await expect(blocker).toBeVisible();
    await expect(blocker.getByRole("link", { name: /^Resolve/ })).toHaveCount(0);
    await expect(blocker.getByRole("link", { name: /^Open/ })).toHaveAttribute("href", /^\/baseline\?tab=blockers&blocker=/);
  });

  test("D-7: a failed setup load shows Try again where Set up goes", async ({ page }) => {
    await failing(page, "/v1/setup");
    await openHome(page);
    const error = page.getByTestId("home-setup-load-error");
    await expect(error).toContainText("Couldn't load your setup checklist.");
    await stopFailing(page);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("home-setup")).toBeVisible();
    await expect(page.getByTestId("home-setup-load-error")).toHaveCount(0);
  });

  test("D-7: a viewer, who has no Set up, sees no setup error", async ({ page }) => {
    await failing(page, "/v1/setup");
    await openHome(page, "viewer");
    await expect(page.getByTestId("home-goals").or(page.locator("[data-testid^='home-goal-']").first())).toBeVisible();
    await expect(page.getByTestId("home-setup-load-error")).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const theme of ["light", "dark"]) {
    test(`D-6: Set up rows stack the name above the status, whole, the button on the right (${theme})`, async ({ page }) => {
      await page.addInitScript(([k, t]) => {
        localStorage.setItem(k, "empty");
        localStorage.setItem("oracle-theme", t);
      }, [MOCK_SCENARIO_KEY, theme] as const);
      await openHome(page);
      const rows = page.getByTestId("home-setup").locator("li[data-testid^='setup-row-']");
      await expect(rows.first()).toBeVisible();
      const bad = await rows.evaluateAll((els) =>
        els.flatMap((li) => {
          const name = li.querySelector<HTMLElement>("[data-testid='setup-name']");
          const status = li.querySelector<HTMLElement>("[data-testid='setup-status']");
          const button = li.querySelector<HTMLElement>("[data-testid='setup-action']");
          const key = li.getAttribute("data-testid");
          if (!name || !status) return [`${key}: no name or status`];
          const out: string[] = [];
          for (const el of [name, status]) if (el.scrollWidth > el.clientWidth + 1) out.push(`${key}: "${el.textContent}" cut`);
          const n = name.getBoundingClientRect();
          const s = status.getBoundingClientRect();
          if (s.top < n.bottom - 1) out.push(`${key}: status not under the name`);
          if (button && button.getBoundingClientRect().left < Math.max(n.right, s.right) - 1) out.push(`${key}: button not on the right`);
          return out;
        }),
      );
      expect(bad).toEqual([]);
    });
  }
});
