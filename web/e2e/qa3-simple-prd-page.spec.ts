import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { ADMIN, login } from "./helpers";
import { expect, test, type Page } from "./test";

/*
 * QA pass 3 on the Simple PRD pages (qa-simple-prd-p3-1 ... 28), driven through the UI on the
 * mock: the one-pager without a plan (the default scenario's Guided setup) and with a plan
 * ("simple-plan", "simple-plan-partly-dated", "simple-plan-undated": M1 Prove it 2 Nov - 27 Nov,
 * M2 Scale volume, M3 Open to all; the mock's today is 22 Oct).
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function plan(page: Page, scenario = "simple-plan", email: string = ADMIN.email) {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page, email);
  await page.goto("/simple");
  await page.locator('nav[aria-label="Simple"]:visible').getByRole("link", { name: "One-pagers" }).click();
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Guided setup" }).click();
  await expect(page).toHaveURL(/\/simple\/one-pagers\/guided-setup$/);
  await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
}

async function paper(page: Page, email: string = ADMIN.email) {
  await login(page, email);
  await page.goto("/simple/one-pagers");
  await page.getByTestId("simple-one-pagers").getByRole("link", { name: "Team workspaces PRD" }).click();
  await expect(page.getByRole("article", { name: "One-pager" })).toBeVisible();
}

const line = (page: Page, id: string) => page.locator(`[data-line="${id}"]`);
const afterHeight = (page: Page, sel: ReturnType<Page["locator"]>) => sel.evaluate((el) => parseFloat(getComputedStyle(el, "::after").height));

test.describe("desktop, a plan", () => {
  test.use({ viewport: DESKTOP });

  test("bars name their work; the picker and a bar bring the card into view, the bar's features marked (p3-3, 8, 9)", async ({ page }) => {
    await plan(page);
    const tl = page.getByRole("region", { name: "Timeline" });
    const bars = tl.getByTestId("timeline-bar");
    await expect(bars.first()).toBeVisible();
    for (const t of await bars.allTextContents()) {
      expect(t, "a bar shows words, not only codes").not.toMatch(/^F-\d+[a-z]?( \+\d+)?$/);
      expect(t).toMatch(/[A-Za-z]{3}/);
    }
    const part = page.getByTestId("milestone-part");
    await tl.getByRole("group", { name: "Milestones" }).getByRole("button", { name: /M2 Scale volume/ }).click();
    await expect(part.getByRole("heading", { level: 2 })).toHaveText("M2 Scale volume");
    await expect(part.getByRole("heading", { level: 2 })).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, 0));
    const m3 = tl.locator('[data-testid="timeline-bar"][data-milestone="M3"]').filter({ hasText: "+" }).first();
    const held = (await m3.getAttribute("title"))!.split("\n").map((x) => x.split(" ")[0]);
    await m3.click();
    await expect(part.getByRole("heading", { level: 2 })).toHaveText("M3 Open to all");
    const marked = part.locator('[data-marked="true"]');
    await expect(marked).toHaveCount(held.length);
    for (const code of held) await expect(marked.filter({ hasText: code })).toHaveCount(1);
  });

  test("Q8 says whose decision it is; Q3 is late in one style everywhere (p3-10, 11)", async ({ page }) => {
    await plan(page);
    const tl = page.getByRole("region", { name: "Timeline" });
    await expect(tl.getByTestId("timeline-decision").filter({ hasText: "Q8" })).toContainText("M2 decision, taken at the M1 review, 27 Nov");
    const q3 = tl.getByTestId("timeline-decision").filter({ hasText: "Q3" }).locator("small");
    await expect(q3).toHaveText("was due 20 Oct");
    const card = page.getByTestId("part-decisions").getByRole("listitem").filter({ hasText: "Q3" }).getByText("was due 20 Oct");
    const colour = (l: typeof q3) => l.evaluate((el) => getComputedStyle(el).color);
    expect(await colour(card)).toBe(await colour(q3));
  });

  test("the plan's words can be changed from the page (p3-4)", async ({ page }) => {
    await plan(page);
    await expect(page.getByRole("button", { name: /^Edit “/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit the wording" }).click();
    await page.locator('[data-line="risks-1"]').hover();
    await expect(page.getByRole("button", { name: /^Edit “Calendar access/ })).toBeVisible();
  });

  test("partly dated: every dated decision on the line, the plan not squeezed, and Read again names what is left (p3-5, 6, 7)", async ({ page }) => {
    await plan(page, "simple-plan-partly-dated");
    const tl = page.getByRole("region", { name: "Timeline" });
    const ds = tl.getByTestId("timeline-decision");
    await expect(ds.filter({ hasText: "Q7" })).toBeVisible();
    await expect(ds.filter({ hasText: "Q8" })).toBeVisible();
    const strip = (await tl.getByTestId("timeline-strip").boundingBox())!;
    const col = { x: strip.x + 300, w: strip.width - 300 };
    const firstBar = Math.min(...(await tl.getByTestId("timeline-bar").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x))));
    expect((firstBar - col.x) / col.w).toBeLessThan(0.25);
    const note = tl.getByTestId("timeline-no-dates");
    await note.getByRole("button", { name: "Read the plan again" }).click();
    await expect(note.getByRole("status")).toHaveText("Read again: M2 and M3 still have no dates.");
  });

  test("no dates: no zero counts, 'No dates yet' once, the note above the list (p3-12, 13)", async ({ page }) => {
    await plan(page, "simple-plan-undated");
    const part = page.getByTestId("milestone-part");
    await expect(part.getByTestId("part-builds")).not.toContainText("0 features");
    expect((await part.innerText()).match(/No dates yet/g)?.length).toBe(1);
    const tl = page.getByRole("region", { name: "Timeline" });
    const note = (await tl.getByTestId("timeline-no-dates").boundingBox())!;
    const list = (await tl.getByTestId("timeline-undated-milestone").first().boundingBox())!;
    expect(note.y).toBeLessThan(list.y);
    // Q3 is overdue in the list as it is in the card.
    await expect(tl.getByTestId("timeline-undated-milestone").first()).toContainText("was due 20 Oct");
  });
});

test.describe("phone, a plan", () => {
  test.use({ viewport: PHONE });

  test("no dates: the note first, links without zero counts, tap areas of 44 px (p3-12, 13, 21)", async ({ page }) => {
    await plan(page, "simple-plan-undated");
    const tl = page.getByRole("region", { name: "Timeline" });
    const note = (await tl.getByTestId("timeline-no-dates").boundingBox())!;
    const first = (await tl.getByTestId("timeline-step").first().boundingBox())!;
    expect(note.y).toBeLessThan(first.y);
    const link = tl.getByTestId("timeline-step").first().getByRole("link");
    await expect(link).not.toContainText(/\b0 (features|flows)/);
    expect(await afterHeight(page, link)).toBeGreaterThanOrEqual(44);
    expect(await afterHeight(page, page.getByRole("link", { name: "Open the detailed view" }).first())).toBeGreaterThanOrEqual(44);
  });

  test("counts, dates and engineer-weeks stay together (p3-20, 21)", async ({ page }) => {
    await plan(page);
    const part = page.getByTestId("milestone-part");
    const pm = part.locator("h4").filter({ hasText: /Product manager/i });
    if (await pm.count()) expect(await pm.first().evaluate((el) => el.textContent)).toMatch(/engineering · \d/i);
    const dates = part.getByTestId("part-dates");
    const keep = await dates.locator("span.whitespace-nowrap").allTextContents();
    expect(keep.some((t) => /engineer-weeks/.test(t))).toBe(true);
    const flowBelow = part.getByRole("button", { name: "flow below" }).first();
    if (await flowBelow.count()) expect(await afterHeight(page, flowBelow)).toBeGreaterThanOrEqual(44);
  });
});

test.describe("desktop, no plan", () => {
  test.use({ viewport: DESKTOP });

  test("the editor takes the cursor; Escape and Ctrl+Enter; an empty line says why (p3-2, 27)", async ({ page }) => {
    await paper(page);
    await line(page, "not_doing-2").hover();
    await page.getByRole("button", { name: "Edit “A mobile setup flow" }).click();
    const box = page.getByLabel("New wording for");
    await expect(box).toBeFocused();
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBe("A mobile setup flow".length);
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit “A mobile setup flow" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await box.fill("");
    await expect(page.getByTestId("line-edit-empty")).toContainText("A line needs words");
    await box.fill("A phone setup flow");
    await page.keyboard.press("Control+Enter");
    await expect(line(page, "not_doing-2")).toHaveAttribute("data-state", "edited");
  });

  test("pointing at a line moves no words; its sources mark the line (p3-25, 26)", async ({ page }) => {
    await paper(page);
    const text = line(page, "problem-1").getByTestId("one-pager-line-text");
    const before = (await text.boundingBox())!.width;
    await text.hover();
    await expect(page.getByRole("button", { name: /^Edit “New workspace admins/ })).toBeVisible();
    expect((await text.boundingBox())!.width).toBe(before);
    await page.getByRole("button", { name: /Calendar access may scare admins away/ }).click();
    const sources = page.getByRole("region", { name: /Sources of “Calendar access/ });
    await expect(sources.getByTestId("source-line")).toHaveText("Calendar access may scare admins away");
  });

  test("the same header as a plan's, its status as the list's; the strip's legend (p3-16, 15)", async ({ page }) => {
    await login(page);
    await page.goto("/simple/one-pagers");
    const row = page.getByTestId("one-pager-row").filter({ hasText: "Team workspaces PRD" });
    await expect(row).toContainText("In review");
    const listed = "In review";
    await row.getByRole("link", { name: "Team workspaces PRD" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Team workspaces PRD" })).toBeVisible();
    await expect(page.getByRole("article", { name: "One-pager" }).getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(page.getByTestId("one-pager-meta")).toContainText(listed);
    await expect(page.getByTestId("one-pager-meta").locator("b").filter({ hasText: /\S/ }).first()).toBeVisible();
    const legend = page.getByTestId("plan-strip-legend");
    await expect(legend).toContainText("Today 22 Oct");
    await expect(legend).toContainText("hatched = not confirmed");
    await expect(legend).toContainText("milestone end");
    await expect(page.getByLabel("Timeline strip")).toContainText("12 roadmap items");
  });

  test("a viewer's header: four actions alike, the reason under Start review (p3-28)", async ({ page }) => {
    await paper(page, "viewer@example.com");
    const present = page.getByRole("button", { name: "Present" });
    const detailed = page.getByRole("link", { name: "Open the detailed view" }).first();
    const style = (l: typeof present) => l.evaluate((el) => { const s = getComputedStyle(el); return [s.borderTopWidth, s.borderTopStyle, s.textDecorationLine, s.minHeight].join(" "); });
    expect(await style(detailed)).toBe(await style(present));
    const start = (await page.getByRole("button", { name: "Start review" }).boundingBox())!;
    const why = (await page.getByTestId("start-review-why").boundingBox())!;
    expect(why.y).toBeGreaterThanOrEqual(start.y + start.height);
  });

  test("a commenter's own proposal is theirs, and withdrawn (p3-17)", async ({ page }) => {
    await paper(page, "commenter@example.com");
    await line(page, "not_doing-1").hover();
    await page.getByRole("button", { name: "Propose wording for “Single sign-on setup" }).click();
    await page.getByLabel("New wording for").fill("Single sign-on, later");
    await page.getByRole("button", { name: "Propose", exact: true }).click();
    const note = page.getByRole("note").filter({ hasText: "You propose new wording for “Single sign-on setup" }).filter({ visible: true });
    await expect(note).toBeVisible();
    await expect(note).not.toContainText("Commenter proposes");
    await note.getByRole("button", { name: "Withdraw" }).click();
    await expect(page.getByRole("note").filter({ hasText: "Single sign-on setup" })).toHaveCount(0);
  });

  test("presenting keeps focus on the page, and Escape stops it (p3-18, 19)", async ({ page }) => {
    await paper(page);
    // Where full screen is refused (an iPhone's Safari), presenting still starts and Escape ends it.
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = () => Promise.reject(new Error("refused"));
    });
    await page.getByRole("button", { name: "Present" }).click();
    const stop = page.getByRole("button", { name: "Stop presenting" });
    await stop.focus();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="one-pager"]'))).toBe(true);
    }
    await expect(page.getByTestId("one-pager")).toHaveAttribute("data-presenting", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("one-pager")).not.toHaveAttribute("data-presenting", "true");
    await expect(page.locator("[inert]")).toHaveCount(0);
  });
});

test.describe("phone, no plan", () => {
  test.use({ viewport: PHONE });

  test("a hidden Edit takes no tap (p3-1)", async ({ page }) => {
    await paper(page);
    const row = line(page, "bets-1");
    const edit = row.locator("[data-edit-for]");
    // A phone has no pointer resting on the page.
    await page.mouse.move(1, 1);
    const b = (await row.getByTestId("one-pager-line-text").boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-edit-for]") != null, [b.x + b.width - 10, b.y + 10]);
    expect(hit).toBe(false);
    await expect(edit).toHaveCSS("pointer-events", "none");
  });
});
