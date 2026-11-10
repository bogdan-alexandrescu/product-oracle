import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * roadmap-milestone-codes (the owner, Nov 9: "milestones cut across the entire rows of the roadmap"
 * and "milestones should have a unique number (m1, m2, m3) and shouldn't show up more than once"),
 * on invented data (the mock's "roadmap-milestones" scenario: 4 goals, milestones from Nov to Feb,
 * two on Dec 22, a PRD's own one, work of no goal; the mock's today is Nov 3, 2026).
 *
 * Card roadmap-milestone-band: protects = on the Timeline and the Gantt every milestone's line
 * runs through every group, and one Milestones band under the date axis names each milestone
 * once, coded M1..Mn by date across the roadmap; fails_when = a line stops at its own goal's rows,
 * a code repeats, has a suffix or is out of date order.
 * Card roadmap-milestone-renumber: protects = moving a milestone earlier gives it the earlier
 * code and renumbers the ones it passed; fails_when = it keeps its old code.
 * Card roadmap-filter-codes: protects = a Roadmap filter keeps every shown milestone's code (they
 * are numbered over every roadmap, as Home and the Goal map read them); fails_when = the codes are
 * numbered from the filtered read and shift.
 * Card roadmap-band-more: protects = a milestone folded into the band's "+N" is listed by name and
 * day on hover, focus or a click, and its entry opens its card; fails_when = "+N" only has a title.
 * Card home-roadmap-codes: protects = Home's "The plan this quarter" rows read a milestone by
 * the code the roadmap shows; fails_when = Home shows a goal's own code.
 */

const SCENARIO = "roadmap-milestones";

async function open(page: Page, scenario = SCENARIO) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [MOCK_SCENARIO_KEY, scenario] as const);
  await login(page);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
  await expect(page.getByTestId("ms-band")).toBeVisible();
}

const labels = (page: Page) => page.locator('[data-testid="ms-label"], [data-testid="ms-prd-label"]');

/** Every milestone the band names (a folded count's names after its host), by day: [code, name]. */
async function bandCodes(page: Page): Promise<[string, string][]> {
  const shown: { day: string; words: string }[] = [];
  for (const l of await labels(page).all()) shown.push({ day: (await l.getAttribute("data-day")) ?? "", words: (await l.innerText()).trim() });
  for (const more of await page.getByTestId("ms-band-more").all()) {
    const days = ((await more.getAttribute("data-days")) ?? "").split(",");
    const entries = await more.locator("xpath=..").getByTestId("ms-band-entry").allTextContents();
    entries.forEach((t, k) => shown.push({ day: days[k] ?? "", words: t.split(" · ")[0].trim() }));
  }
  // By day; on one day, by code (the band may stack or fold a day's labels in any order).
  const num = (w: string) => Number(/^M(\d+)/.exec(w)?.[1] ?? 0);
  return shown
    .sort((a, b) => a.day.localeCompare(b.day) || num(a.words) - num(b.words))
    .map(({ words: w }) => [w.split(" ")[0], w.slice(w.indexOf(" ") + 1)] as [string, string]);
}

async function linesSpanEveryGroup(page: Page, layer: Locator) {
  const box = (await layer.boundingBox())!;
  const lines = layer.getByTestId("ms-line");
  const n = await lines.count();
  expect(n).toBeGreaterThan(4);
  // The rows of every group: the last one ends near the layer's foot, the first starts under the band.
  for (const line of await lines.all()) {
    const b = (await line.boundingBox())!;
    expect(b.y).toBeLessThan(box.y + 120);
    expect(b.y + b.height).toBeGreaterThan(box.y + box.height - 4);
  }
  return n;
}

test("on the Timeline every milestone's line runs through every group and the band codes them M1..Mn by date", async ({ page }) => {
  await open(page);
  const n = await linesSpanEveryGroup(page, page.getByTestId("ms-layer").first());
  const codes = await bandCodes(page);
  const nums = codes.map(([c]) => {
    expect(c).toMatch(/^M\d+$/);
    return Number(c.slice(1));
  });
  // Each once, in date order, no suffix, no repeat: M1..Mn.
  expect(new Set(nums).size).toBe(nums.length);
  expect(nums).toEqual([...nums].sort((a, b) => a - b));
  expect(nums.length).toBe(n);
  // With the track milestones the Timeline names over its axis ("◆ M6 Beta · Dec 31"): M1..Mn, each once.
  const tracks = (await page.getByTestId("timeline-milestone").allInnerTexts()).map((t) => Number(/M(\d+)/.exec(t)?.[1]));
  const all = [...nums, ...tracks].sort((a, b) => a - b);
  expect(all).toEqual(all.map((_, k) => k + 1));
  // Two on Dec 22 get two numbers in a row.
  const dec22 = codes.filter(([, name]) => name === "60% of teams active at day 90" || name === "Half of new teams invite a teammate").map(([c]) => Number(c.slice(1)));
  expect(dec22).toHaveLength(2);
  expect(Math.abs(dec22[0] - dec22[1])).toBe(1);
  // The PRD's milestone is drawn like the others, its tip naming its PRD and the goal it advances.
  const prd = page.getByTestId("ms-prd-label").first();
  await prd.hover();
  await expect(page.getByTestId("ms-band-tip")).toContainText("From the PRD Usage alerts");
  await expect(page.getByTestId("ms-band-tip")).toContainText("Advances");
});

test("on the Gantt every milestone's line runs through every group, each named once in the band", async ({ page }) => {
  await open(page);
  await page.getByTestId("format-gantt").click();
  await expect(page.getByTestId("ms-band")).toBeVisible();
  await linesSpanEveryGroup(page, page.getByTestId("ms-layer").first());
  const nums = (await bandCodes(page)).map(([c]) => Number(c.slice(1)));
  expect(new Set(nums).size).toBe(nums.length);
  expect(nums).toEqual([...nums].sort((a, b) => a - b));
});

test("moving a milestone earlier renumbers it and the ones it passed", async ({ page }) => {
  await open(page);
  const before = new Map((await bandCodes(page)).map(([c, name]) => [name, c]));
  const last = before.get("Digest opened by 70%")!;
  const first = before.get("Alerts live for 50 teams")!;
  expect(Number(last.slice(1))).toBeGreaterThan(Number(first.slice(1)));
  await labels(page).filter({ hasText: "Digest opened by 70%" }).click();
  const card = page.getByTestId("ms-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Date").fill("2026-11-10");
  await card.getByTestId("ms-save").click();
  await expect(card).toBeHidden();
  await expect(labels(page).filter({ hasText: "Digest opened by 70%" })).toHaveText(/^M1 /);
  await expect(labels(page).filter({ hasText: "Alerts live for 50 teams" })).toHaveText(new RegExp(`^M${Number(first.slice(1)) + 1} `));
});

test("Home's plan rows read each milestone by the code the roadmap shows", async ({ page }) => {
  await open(page);
  const onRoadmap = new Map((await bandCodes(page)).map(([c, name]) => [name, c]));
  await page.goto("/simple");
  await expect(page.getByRole("heading", { name: "The plan this quarter" })).toBeVisible();
  await expect(page.getByTestId("home-strip-label").first()).toBeVisible();
  let matched = 0;
  for (const t of await page.getByTestId("home-strip-label").allTextContents()) {
    const m = /^(M\d+) · (.+?) · \d+ items?$/.exec(t.replace(/\s+/g, " ").trim());
    if (!m || !onRoadmap.has(m[2])) continue;
    expect(m[1]).toBe(onRoadmap.get(m[2]));
    matched += 1;
  }
  expect(matched).toBeGreaterThan(0);
});

test("a Roadmap filter keeps each shown milestone's code", async ({ page }) => {
  await open(page);
  const whole = new Map((await bandCodes(page)).map(([c, name]) => [name, c]));
  const pick = page.getByTestId("filter-roadmap");
  const values = (await pick.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
  expect(values.length).toBeGreaterThan(1);
  let compared = 0;
  for (const v of values) {
    await pick.selectOption(v);
    await expect(pick).toHaveValue(v);
    await page.waitForLoadState("networkidle");
    if (!(await page.getByTestId("ms-band").isVisible())) continue;
    for (const [code, name] of await bandCodes(page)) {
      expect(code, `${name} keeps its code`).toBe(whole.get(name));
      compared += 1;
    }
  }
  expect(compared).toBeGreaterThan(0);
});

test("the band's +N lists the milestones it folds by name and day, and each opens its card", async ({ page }) => {
  await open(page);
  await page.getByTestId("zoom-all").click();
  const more = page.getByTestId("ms-band-more").first();
  await expect(more).toBeVisible();
  const list = more.locator("xpath=..").getByTestId("ms-band-list");
  await expect(list).toBeHidden();
  await more.focus();
  await expect(list).toBeVisible();
  const entry = list.locator('[data-testid="ms-band-entry"]:not([data-prd])').first();
  await expect(entry).toHaveText(/^M\d+ .+ · [A-Z][a-z]{2} \d{1,2}$/);
  const name = (await entry.innerText()).split(" · ")[0].replace(/^M\d+ /, "");
  await more.click();
  await entry.click();
  await expect(page.getByTestId("ms-card").getByLabel("Name")).toHaveValue(name);
});

/*
 * Card roadmap-band-joined (the owner's "Join whenever names match", Nov 9), on
 * "home-milestones-goals-fold": protects = the Setup guide PRD's "M1 Measured" under a goal, beside
 * another goal's M1, joins the track's "M1 · Measured and mapped": its band label reads the longer
 * name and its tip lists the other ("Also: M1 Measured"); fails_when = the band shows "Measured"
 * alone, or the other name shows nowhere.
 */
test("a joined milestone's band label reads the longer name, its tip the other", async ({ page }) => {
  await open(page, "home-milestones-goals-fold");
  const label = labels(page).filter({ hasText: /^M\d+ Measured and mapped$/ });
  await expect(label).toHaveCount(1);
  const code = (await label.innerText()).split(" ")[0];
  await label.hover();
  const tip = page.getByTestId("ms-band-tip");
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId("ms-band-also")).toHaveText(`Also: ${code} Measured`);
  await expect(labels(page).filter({ hasText: /^M\d+ Measured$/ })).toHaveCount(0);
  // Its card edits the PRD's own milestone and names the joined one's other name.
  await label.click();
  await expect(page.getByTestId("ms-card").getByLabel("Name")).toHaveValue("Measured");
  await expect(page.getByTestId("ms-card-also")).toHaveText(`Also: ${code} Measured and mapped`);
});
