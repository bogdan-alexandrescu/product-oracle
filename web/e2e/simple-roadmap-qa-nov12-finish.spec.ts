import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-roadmap.md), the parts of #5 and #8 left
 * after the first pass, driven as a person does against the mock's invented data (mock clock:
 * Oct 22, 2026): #5 an end past its milestone names the milestone with its code ("M1 Beta") in the
 * feature panel's warnings and on the board's card too, not only in Needs a decision; #8 at All 3
 * years a milestone's label is never cut to "M1 B…" and no label, "+N" or count bubble, or
 * "+ Milestone" hint lies on a month's name.
 */

const KEY = "alert-digest";

async function open(page: Page, format: "timeline" | "board") {
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId(`format-${format}`).click();
  await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
}

test.use({ viewport: { width: 1440, height: 900 } });

test("#5: the feature panel's warning names the milestone with its code", async ({ page }) => {
  // protects: Weekly alert digest's panel says its end is "after its milestone ‘M1 Beta’", as Needs a decision does
  // fails_when: the panel's warning says "after its milestone ‘Beta’"
  await open(page, "timeline");
  await page.locator(`[data-testid="timeline-row"][data-item="${KEY}"]`).getByTestId("timeline-bar").click();
  const warn = page.getByTestId("card-flags").getByTestId("flag-reason").filter({ hasText: "after its milestone" });
  await expect(warn).toContainText(/after its milestone ‘M\d+ Beta’/);
});

test("#5: the board's card names the milestone with its code", async ({ page }) => {
  // protects: Weekly alert digest's board card says its end is "after its milestone ‘M1 Beta’"
  // fails_when: the card says "after its milestone ‘Beta’"
  await open(page, "board");
  const card = page.locator(`[data-testid="board-card"][data-item="${KEY}"]`);
  await expect(card.getByText(/after its milestone/)).toContainText(/after its milestone ‘M\d+ Beta’/);
});

test("#8: at All 3 years a milestone's label reads its code and name whole, and nothing on the axis lies on a month's name", async ({ page }) => {
  // protects: the M1 Beta label at All 3 years shows "M1 Beta" uncut; no milestone label, "+N", same-day count or "+ Milestone" hint overlaps a month's name
  // fails_when: the label is cut ("M1 B…") or one of them lies on a month's name
  await open(page, "timeline");
  await page.getByTestId("zoom-all").click();
  await expect(page.getByTestId("zoom-all")).toHaveAttribute("aria-pressed", "true");
  const labels = page.getByTestId("timeline-milestone");
  await expect(labels.first()).toBeVisible();
  for (const l of await labels.all()) {
    await expect(l).toContainText(/M\d+ \S/);
    expect(await l.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${await l.textContent()} is whole`).toBe(true);
  }
  const hits = await page.evaluate(() => {
    const boxes = (s: string) => [...document.querySelectorAll<HTMLElement>(s)].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.width > 0);
    const months = boxes('[data-testid="timeline-month"]');
    const out: string[] = [];
    for (const a of boxes('[data-testid="timeline-milestone"],[data-testid="timeline-milestone-more"],[data-testid="ms-same-day"],[data-testid="ms-add-hint"]'))
      for (const m of months)
        if (a.r.left < m.r.right && m.r.left < a.r.right && a.r.top < m.r.bottom - 1 && m.r.top < a.r.bottom - 1) out.push(`${a.e.textContent} / ${m.e.textContent}`);
    return out;
  });
  expect(hits).toEqual([]);
});

test("#5: the Gantt's and the Waterfall's bar names the milestone with its code", async ({ page }) => {
  // protects: Weekly alert digest's bar on the Gantt and the Waterfall is named "… after its milestone ‘M1 Beta’ …", as Needs a decision says it
  // fails_when: the bar's name says "after its milestone ‘Beta’"
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible({ timeout: 15_000 });
  for (const format of ["gantt", "waterfall"]) {
    await page.getByTestId(`format-${format}`).click();
    await expect(page.getByTestId(`format-${format}`)).toHaveAttribute("aria-pressed", "true");
    const bar = page.locator(`[data-testid="bar"][data-item="${KEY}"]`).first();
    await expect(bar, format).toHaveAttribute("aria-label", /after its milestone ‘M\d+ Beta’/);
  }
});
