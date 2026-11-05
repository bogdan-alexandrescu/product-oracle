import { expect, test, type Page } from "./test";

import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { ROADMAP_REVIEW_RUN, RUN_REVIEW_RUN } from "../lib/api/mock/runs";
import { login, seedRun } from "./helpers";

/*
 * Visual QA pass B (task_5580666d17444da7935f) on Runs, Inbox and Priorities, driven through
 * the UI on the mock:
 * B-06 a roadmap reason reads its date month first on the run page, also one stored before
 *      the API wrote it so;
 * B-16 the PRD review line takes the full width on a phone, Open review below it;
 * B-17 a viewer's runs list says who a waiting review waits on;
 * B-21 the runs list filters by state and by words;
 * B-15 an Inbox date suggestion after the planning horizon carries a Far out chip, its reason
 *      in the (i) beside it, read by touch on a phone, light and dark;
 * B-22 three or more runs of one flow waiting at the same stop read as one Inbox row, its new
 *      runs under New and its seen runs under Seen, light and dark;
 * B-19 Priorities follows the scenario: none for a new company, many for a large one.
 */

const scenario = (page: Page, name: string) => page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, name] as const);
const rows = (page: Page) => page.getByTestId("run-row");
const theme = (page: Page, t: "light" | "dark") => page.addInitScript((t) => localStorage.setItem("oracle-theme", t), t);
const FAR_OUT_TIP = "Low confidence, after the planning horizon (Feb 28, 2027)";

/** The contrast of an element's text on the first background behind it that is not clear. */
async function textContrast(el: ReturnType<Page["locator"]>): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(rgb(getComputedStyle(node).color)), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

/**
 * Seeds two of the large company's grouped runs as arrived after my last visit, the rest
 * before it, so the group's runs split between New and Seen.
 */
/**
 * Where an open tooltip's corners are covered: each corner, 3 px in, that the page's top
 * element there is not the tooltip or inside it (none when it is really on top).
 */
async function coveredCorners(tip: ReturnType<Page["locator"]>): Promise<string[]> {
  return tip.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const corners: [string, number, number][] = [
      ["top left", r.left + 3, r.top + 3],
      ["top right", r.right - 3, r.top + 3],
      ["bottom left", r.left + 3, r.bottom - 3],
      ["bottom right", r.right - 3, r.bottom - 3],
    ];
    return corners.filter(([, x, y]) => !node.contains(document.elementFromPoint(x, y))).map(([name]) => name);
  });
}

/** Whether two boxes overlap. */
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function seedGroupSeen(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const write = (globalThis as { __poMockWrite?: (change: (db: any) => string) => Promise<string> }).__poMockWrite;
    if (!write) throw new Error("The mock API is not loaded: sign in before seeding");
    return write((db) => {
      type C = { status: string; created_at: string };
      const runs: { document_slug: string; checkpoints: C[] }[] = db.runs.runs;
      for (const r of runs) for (const c of r.checkpoints) if (c.status === "pending") c.created_at = "2026-10-01T09:00:00Z";
      const copies = runs.filter((r) => /-\d+$/.test(r.document_slug) && r.checkpoints.some((c) => c.status === "pending"));
      for (const r of copies.slice(0, 2)) for (const c of r.checkpoints) if (c.status === "pending") c.created_at = "2026-10-01T12:00:00Z";
      db.inbox_seen = Object.fromEntries((db.members as { id: string }[]).map((m) => [m.id, "2026-10-01T10:00:00Z"]));
      return "seeded";
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("B-06: a stored ISO date in a roadmap reason reads month first on the run page", async ({ page }) => {
    // A run past its Roadmap items stop (its reasons listed on the run page), with a reason
    // stored before the API wrote days month first.
    const run = JSON.parse(JSON.stringify(ROADMAP_REVIEW_RUN)) as typeof ROADMAP_REVIEW_RUN;
    for (const c of run.run.checkpoints) c.status = "approved";
    const [items] = run.run.segments;
    for (const r of items.items_check!.reasons) r.text = r.text.replace("Nov 30, 2026", "2026-11-30");
    await login(page);
    await seedRun(page, run);
    await page.goto(`/runs/${run.run.id}`);
    const reason = page.locator('[data-testid="item-reason"][data-code="unverified_date"]').getByTestId("reason-text");
    await expect(reason).toHaveText("No verified estimate, capacity or commitment supports Nov 30, 2026.");
    await expect(page.getByTestId("items-reasons")).not.toContainText("2026-11-30");
  });

  test("B-17: a viewer's runs list says the approvers review a run waiting at its checkpoint", async ({ page }) => {
    await login(page, "viewer@example.com");
    await page.goto("/runs");
    await expect(page.getByTestId("runs-waiting-others")).toBeVisible();
    const waiting = rows(page).filter({ has: page.getByTestId("run-status").getByText("Waiting for review", { exact: true }) });
    await expect(waiting.first()).toBeVisible();
    for (const row of await waiting.all()) await expect(row.getByTestId("run-waits-on")).toHaveText("Approvers review");
    await expect(page.getByTestId("run-waits-on").filter({ hasText: /^Owner approves \$/ })).toHaveCount(1);
  });

  test("B-21: a large runs list filters by Waiting on me, Running and Done, and by search", async ({ page }) => {
    await scenario(page, "large");
    await login(page);
    await page.goto("/runs");
    const filters = page.getByRole("group", { name: "Show runs" });
    const all = filters.getByRole("button", { name: /^All/ });
    await expect(all).toHaveAttribute("aria-pressed", "true");
    const total = Number(await all.locator("b").textContent());
    expect(total).toBeGreaterThan(50);
    await expect(rows(page)).toHaveCount(total);

    await filters.getByRole("button", { name: /^Running/ }).click();
    const running = Number(await filters.getByRole("button", { name: /^Running/ }).locator("b").textContent());
    expect(running).toBeGreaterThan(0);
    await expect(rows(page)).toHaveCount(running);
    for (const s of await rows(page).getByTestId("run-status").allTextContents()) expect(["Running", "Delivering decision"]).toContain(s);
    await expect(page.getByTestId("panel-count")).toHaveText(`${running} of ${total}`);

    await filters.getByRole("button", { name: /^Waiting on me/ }).click();
    const mine = Number(await filters.getByRole("button", { name: /^Waiting on me/ }).locator("b").textContent());
    await expect(rows(page)).toHaveCount(mine);
    await expect(page.getByTestId("runs-table").getByRole("button")).toHaveCount(mine);

    await filters.getByRole("button", { name: /^Done/ }).click();
    for (const s of await rows(page).getByTestId("run-status").allTextContents()) expect(["Succeeded", "Failed", "Cancelled"]).toContain(s);

    await filters.getByRole("button", { name: /^All/ }).click();
    const search = page.getByRole("searchbox", { name: "Search runs" });
    await search.fill("checkout");
    await expect(rows(page).first()).toBeVisible();
    for (const t of await rows(page).allTextContents()) expect(t.toLowerCase()).toContain("checkout");
    await search.fill("no run is called this");
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByTestId("runs-none-match")).toBeVisible();
  });

  test("B-15: an Inbox date suggestion after the planning horizon is marked Far out, its reason on hover", async ({ page }) => {
    await scenario(page, "inbox-reviewer");
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.goto("/inbox");
    const contexts = page.getByTestId("date-suggestion-context");
    await expect(contexts.first()).toBeVisible();
    const far = contexts.filter({ has: page.getByTestId("date-suggestion-far-out") });
    await expect(far.first()).toBeVisible();
    const chip = far.first().getByTestId("date-suggestion-far-out");
    await expect(chip).toHaveText("Far out");
    // Its reason is in the (i) beside it, not a native title.
    await expect(chip).not.toHaveAttribute("title");
    await far.first().getByTestId("date-suggestion-far-out-tip").hover();
    await expect(far.first().getByRole("tooltip")).toHaveText(FAR_OUT_TIP);
    // In the table's cut-off cell it is still all there, on top of every row.
    expect(await coveredCorners(far.first().getByRole("tooltip"))).toEqual([]);
    // Only a suggestion that ends after Feb 28, 2027 carries it.
    for (const t of await contexts.allTextContents()) {
      const year = Number(/(\d{4})(?!.*\d{4})/.exec(t)?.[1]);
      if (t.includes("Far out")) expect(year).toBeGreaterThanOrEqual(2027);
      else expect(/2027|2028/.test(t) && !/(Jan|Feb) \d{1,2}, 2027$/.test(t.trim())).toBe(false);
    }
  });

  test("B-22: three or more runs waiting at the same stop read as one Inbox row, each run with its own action", async ({ page }) => {
    await scenario(page, "large");
    await login(page);
    await page.goto("/inbox");
    const group = page.getByTestId("checkpoint-group").first();
    await expect(group).toHaveText(/ · \d+ runs$/);
    // Its name says the Ground Truth, never baseline.
    await expect(group).toHaveText(/^Confirm the Ground Truth · \d+ runs$/);
    const n = Number(/(\d+) runs$/.exec((await group.textContent())!)![1]);
    expect(n).toBeGreaterThan(5);
    // The count still counts each run: the rail badge and the heading agree.
    const waiting = (await page.getByTestId("nav-inbox-badge").first().textContent())!.trim();
    await expect(page.getByText(`${waiting} waiting`)).toBeVisible();
    await expect(page.getByTestId("inbox-needs").getByTestId("panel-count")).toHaveText(waiting);
    // The group is one line, its runs folded under Show runs; opened, each run is a line
    // under it with one action of its own.
    const groupRow = page.getByRole("row").filter({ has: group });
    const under = page.locator("tr[data-child-of]").filter({ has: page.getByTestId("checkpoint-label") });
    await expect(under).toHaveCount(0);
    await groupRow.getByRole("button", { name: "Show runs" }).click();
    await expect(under).toHaveCount(n);
    for (const row of await under.all()) await expect(row.getByRole("link", { name: /^(Review|Decide|Open)$/ })).toHaveCount(1);
    await groupRow.getByRole("button", { name: "Hide runs" }).click();
    await expect(under).toHaveCount(0);
  });

  test("B-22: a group is New while any of its runs is new; its seen runs are under Seen, each tab counting what it lists", async ({ page }) => {
    await scenario(page, "large");
    await login(page);
    await seedGroupSeen(page);
    await page.goto("/inbox");
    const tabs = page.getByTestId("inbox-state-tabs");
    const tabCount = async (name: string) => Number(/(\d+)$/.exec((await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).textContent())!.trim())?.[1] ?? 0);
    const listed = async () => {
      const groups = page.getByTestId("checkpoint-group");
      let n = (await page.locator("[role=tabpanel] tr[data-need]:not([data-child-of])").count()) - (await groups.count());
      for (const g of await groups.all()) n += Number(/(\d+) runs?$/.exec((await g.textContent())!)![1]);
      return n;
    };
    const open = async (runs: number) => {
      const group = page.getByTestId("checkpoint-group");
      await expect(group).toHaveCount(1);
      await expect(group).toHaveText(new RegExp(` · ${runs} runs?$`));
      await page.getByRole("row").filter({ has: group }).getByRole("button", { name: "Show runs" }).click();
      await expect(page.locator("tr[data-child-of]").filter({ has: page.getByTestId("checkpoint-label") })).toHaveCount(runs);
    };
    await expect(page.getByTestId("inbox-tab-new")).toBeVisible();
    // Two new runs are fewer than three: plain rows, never a group of them.
    await expect(page.getByTestId("checkpoint-group")).toHaveCount(0);
    await expect(page.locator("[role=tabpanel] tr[data-need]").getByTestId("checkpoint-label").filter({ hasText: /^Confirm the baseline/ })).toHaveCount(2);
    expect(await listed()).toBe(await tabCount("New"));
    await tabs.getByRole("tab", { name: /^Seen/ }).click();
    await expect(page.getByTestId("inbox-tab-open")).toBeVisible();
    await expect(page.getByTestId("checkpoint-group")).toHaveText(/^Confirm the Ground Truth · \d+ runs$/);
    const seen = Number(/(\d+) runs$/.exec((await page.getByTestId("checkpoint-group").textContent())!)![1]);
    expect(seen).toBeGreaterThan(3);
    await open(seen);
    expect(await listed()).toBe(await tabCount("Seen"));
    const waiting = (await page.getByTestId("nav-inbox-badge").first().textContent())!.trim();
    expect((await tabCount("New")) + (await tabCount("Seen"))).toBe(Number(waiting));
  });

  test("B-15 dark: the Far out chip and its reason read in dark", async ({ page }) => {
    await theme(page, "dark");
    await scenario(page, "inbox-reviewer");
    await login(page);
    await page.goto("/simple/roadmap");
    await expect(page.getByTestId("simple-roadmap")).toBeVisible();
    await page.goto("/inbox");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const chip = page.getByTestId("date-suggestion-far-out").first();
    await expect(chip).toHaveText("Far out");
    expect(await textContrast(chip)).toBeGreaterThanOrEqual(4.5);
    const tip = page.getByTestId("date-suggestion-context").filter({ has: chip }).first();
    await tip.getByTestId("date-suggestion-far-out-tip").hover();
    await expect(tip.getByRole("tooltip")).toHaveText(FAR_OUT_TIP);
    expect(await textContrast(tip.getByRole("tooltip"))).toBeGreaterThanOrEqual(4.5);
    expect(await coveredCorners(tip.getByRole("tooltip"))).toEqual([]);
  });

  test("B-22 dark: the grouped checkpoints and their runs read in dark", async ({ page }) => {
    await theme(page, "dark");
    await scenario(page, "large");
    await login(page);
    await page.goto("/inbox");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const group = page.getByTestId("checkpoint-group").first();
    await expect(group).toHaveText(/^Confirm the Ground Truth · \d+ runs$/);
    expect(await textContrast(group)).toBeGreaterThanOrEqual(4.5);
    const groupRow = page.getByRole("row").filter({ has: group });
    const toggle = groupRow.getByRole("button", { name: "Show runs" });
    expect(await textContrast(toggle)).toBeGreaterThanOrEqual(4.5);
    await toggle.click();
    const label = page.locator("tr[data-child-of]").getByTestId("checkpoint-label").first();
    await expect(label).toBeVisible();
    expect(await textContrast(label)).toBeGreaterThanOrEqual(4.5);
  });

  test("B-19: Priorities follows the scenario: none for a new company, many for a large one", async ({ browser }) => {
    for (const [name, check] of [
      ["empty", (n: number) => expect(n).toBe(0)],
      ["large", (n: number) => expect(n).toBeGreaterThan(30)],
    ] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await scenario(page, name);
      await login(page, "approver@example.com");
      await page.goto("/priorities");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      check(await page.locator('tr[data-testid^="priority-row-"]').count());
      await page.close();
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  for (const t of ["light", "dark"] as const) {
    test(`B-15: the Far out reason opens by touch on a phone, ${t}`, async ({ page }) => {
      await theme(page, t);
      await scenario(page, "inbox-reviewer");
      await login(page);
      await page.goto("/simple/roadmap");
      await expect(page.getByTestId("simple-roadmap")).toBeVisible();
      await page.goto("/inbox");
      await expect(page.locator("html")).toHaveAttribute("data-theme", t);
      const far = page.getByTestId("date-suggestion-context").filter({ has: page.getByTestId("date-suggestion-far-out") }).first();
      await expect(far).toBeVisible();
      await far.getByTestId("date-suggestion-far-out-tip").tap();
      const tip = far.getByRole("tooltip");
      await expect(tip).toHaveText(FAR_OUT_TIP);
      const box = (await tip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await textContrast(tip)).toBeGreaterThanOrEqual(4.5);
      expect(await coveredCorners(tip)).toEqual([]);
      // It opens below its chip: over neither its own date line nor the row above's Open.
      const chip = (await far.getByTestId("date-suggestion-far-out").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(chip.y + chip.height);
      const row = page.locator("[data-need]").filter({ has: far });
      const above = page.locator("[data-need]").filter({ has: page.getByRole("link", { name: "Open" }) });
      const rowBox = (await row.first().boundingBox())!;
      for (const open of await above.getByRole("link", { name: "Open" }).all()) {
        const o = (await open.boundingBox())!;
        if (o.y + o.height <= rowBox.y + 1) expect(overlaps(box, o), "covers an Open above it").toBe(false);
      }
    });
  }

  test("B-16: the PRD review line takes the full width on a phone, Open review below it", async ({ page }) => {
    await scenario(page, "run-review");
    await login(page);
    await page.goto(`/runs/${RUN_REVIEW_RUN}`);
    const panel = page.getByTestId("checkpoint-prd_review").filter({ visible: true });
    const text = panel.getByTestId("run-review-summary");
    await expect(text).toHaveText("Waiting for review of v2 · 0/3 sections reviewed");
    const line = await text.boundingBox();
    const button = await panel.getByRole("link", { name: "Open review" }).boundingBox();
    const box = await panel.boundingBox();
    // One or two lines, never a word per line; the button on its own line below.
    expect(line!.height).toBeLessThan(60);
    expect(line!.width).toBeGreaterThan(box!.width * 0.75);
    expect(button!.y).toBeGreaterThanOrEqual(line!.y + line!.height - 1);
  });
});
