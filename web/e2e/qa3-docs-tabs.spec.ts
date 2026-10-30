import { expect, test, type Locator, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 3, docs lane: a PRD version's tabs (Evidence, Impact, Roadmap), Present mode and the
 * text diff of Saved carts v1 -> v2, driven as a person would on the mock.
 */

const DOC = "/documents/saved-carts";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function openEvidence(page: Page, email?: string) {
  await login(page, email);
  await page.goto(`${DOC}/v/2`);
  await page.getByTestId("version-tab-evidence").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/evidence/);
  await expect(page.getByTestId("evidence-coverage")).toBeVisible();
}

/** Any CSS colour (rgb(), color(srgb …), color-mix results) as [r, g, b, alpha] in 0-255. */
const RGB_SRC = `(c) => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const x = cv.getContext("2d");
  x.clearRect(0, 0, 1, 1);
  x.fillStyle = "rgba(0,0,0,0)";
  x.fillStyle = c;
  x.fillRect(0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}`;

/** The element's own background colour. */
async function background(el: Locator): Promise<number[]> {
  return el.evaluate((node, src) => {
    const rgb = new Function(`return ${src}`)() as (c: string) => number[];
    return rgb(getComputedStyle(node).backgroundColor);
  }, RGB_SRC);
}

/** WCAG contrast of an element's text against the first opaque background behind it. */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node, src) => {
    const rgb = new Function(`return ${src}`)() as (c: string) => number[];
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = rgb(getComputedStyle(node).color);
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c[3] > 230) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  }, RGB_SRC);
}

const fontPx = (el: Locator) => el.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));

// --- Evidence ---------------------------------------------------------------------------------

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-21 (${scheme}): the red columns are the ones the legend describes`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: scheme });
    await openEvidence(page);
    const note = page.getByTestId("evidence-footnote");
    await expect(note).toContainText("A red column is a section with no links or citations, in it or in its subsections (the title is never red).");

    const totals = page.getByTestId("evidence-totals").locator("td[data-section]");
    expect(await totals.count()).toBeGreaterThan(0);
    let red = 0;
    for (const td of await totals.all()) {
      const [r, g, b] = await background(td);
      const tinted = r > g + 8 && r > b + 8;
      const gap = (await td.getAttribute("data-gap")) === "true";
      // A red column is exactly an unsupported one; every other column is untinted.
      expect(tinted, `${await td.getAttribute("data-section")}: red ${tinted}, unsupported ${gap}`).toBe(gap);
      if (gap) {
        red++;
        await expect(td).toHaveText("0 links, 0 citations");
      }
    }
    expect(red).toBeGreaterThan(0);
  });
}

test("qa-docs-52: whole headers and counts, and a sign that the table scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await openEvidence(page);
  const scroller = page.getByTestId("evidence-matrix-scroll");
  const overflows = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflows).toBe(true);
  await expect(page.getByTestId("evidence-scroll-hint")).toHaveText("Scroll sideways for more →");
  await expect(page.getByTestId("evidence-scroll-shadow")).toBeAttached();

  // Each column's name is there in full (and as a tooltip); no count is split mid-phrase.
  for (const span of await page.getByTestId("evidence-matrix").locator("thead th[data-section] > span:not(.sr-only)").all()) {
    await expect(span).toHaveAttribute("title", ((await span.textContent()) ?? "").trim());
  }
  for (const td of await page.getByTestId("evidence-totals").locator("td[data-section]").all()) {
    await expect(td).toHaveText(/^\d+ links?, \d+ citations?$/);
    const lines = await td.locator("span").evaluateAll((spans) => spans.map((s) => s.getClientRects().length));
    expect(lines).toEqual([1, 1]);
  }

  // At the right edge, the hint and the shadow go.
  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(page.getByTestId("evidence-scroll-hint")).toHaveCount(0);
  await expect(page.getByTestId("evidence-scroll-shadow")).toHaveCount(0);
});

test("qa-docs-53: an empty chip is not on, the legend uses words, the phone note fits the list", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openEvidence(page);
  const chips = page.getByRole("group", { name: "Rows shown" });
  const links = chips.getByRole("button", { name: /^Links 0$/ });
  await expect(links).toHaveAttribute("aria-pressed", "false");
  await expect(links).toBeDisabled();
  const [lr, lg, lb] = await background(links);
  const [sr, sg, sb] = await background(chips.getByRole("button", { name: /^Stale only/ }));
  expect([lr, lg, lb]).toEqual([sr, sg, sb]);

  const legend = page.getByLabel("Legend");
  await expect(legend).toContainText("Link confidence:");
  for (const word of ["Strong", "Medium", "Weak", "Stale"]) await expect(legend).toContainText(word);
  await expect(legend).not.toContainText(/\d\.\d|0 to 1/);

  await page.setViewportSize(PHONE);
  await expect(page.getByTestId("evidence-list")).toBeVisible();
  const note = page.getByTestId("evidence-footnote");
  await expect(note).toContainText("Each row lists the sections it is linked in.");
  await expect(note).not.toContainText(/red|column/i);
});

test("qa-docs-22: a commenter's Evidence shows their role, not View only", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openEvidence(page, "commenter@example.com");
  const toolbar = page.getByTestId("evidence-toolbar");
  await expect(toolbar.getByText(/Commenter/)).toBeVisible();
  await expect(page.getByText("View only", { exact: true }).filter({ visible: true })).toHaveCount(0);
});

test("qa-docs-8: on a phone the Evidence footnote scrolls clear of the bottom nav", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openEvidence(page);
  const note = page.getByTestId("evidence-footnote");
  await expect(note).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bar = page.getByTestId("tab-bar").filter({ visible: true });
  await expect(bar).toBeVisible();
  await expect
    .poll(async () => {
      const [n, b] = await Promise.all([note.boundingBox(), bar.boundingBox()]);
      return n!.y + n!.height <= b!.y;
    })
    .toBe(true);
});

// --- Impact -----------------------------------------------------------------------------------

test("qa-docs-54: the empty Impact message keeps a readable line length", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto(`${DOC}/v/2/impact`);
  const text = page.getByTestId("impact-empty-text");
  await expect(text).toContainText("No outputs depend on what v2 changed.");
  const box = (await text.boundingBox())!;
  const em = await fontPx(text);
  // At most about 70 characters (ch is about half an em).
  expect(box.width).toBeLessThanOrEqual(em * 0.62 * 70);
  expect(box.height).toBeGreaterThan(em * 2);
});

// --- Roadmap ----------------------------------------------------------------------------------

test("qa-docs-64: the owner's switch says plainly what it does; no Check readiness", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page);
  await page.goto(`${DOC}/v/2/roadmap`);
  const auto = page.getByTestId("draft-roadmap-auto").filter({ visible: true });
  await expect(auto.getByRole("checkbox", { name: "Refresh this roadmap whenever a new PRD version is drafted" })).toBeVisible();
  const toolbar = page.getByTestId("version-toolbar");
  await expect(toolbar.getByRole("link", { name: "Quality" })).toBeVisible();
  await expect(toolbar.getByRole("link", { name: "Check readiness" })).toHaveCount(0);
});

for (const who of ["viewer", "commenter"] as const) {
  test(`qa-docs-64: a ${who} is told who can build the roadmap, with the owner's toolbar`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, `${who}@example.com`);
    await page.goto(`${DOC}/v/2/roadmap`);
    const status = page.getByTestId("draft-roadmap-status").filter({ visible: true });
    await expect(status).toContainText("No roadmap items for this version yet. Approvers and owners can build them.");
    await expect(status.getByRole("button")).toHaveCount(0);
    const toolbar = page.getByTestId("version-toolbar");
    await expect(toolbar.getByRole("link", { name: "Quality" })).toBeVisible();
    await expect(toolbar.getByRole("link", { name: "Check readiness" })).toHaveCount(0);
  });
}

test("qa-docs-65: on a phone the empty roadmap's words sit above its button, and Publish lines up", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto(`${DOC}/v/2/roadmap`);
  const status = page.getByTestId("draft-roadmap-status").filter({ visible: true });
  const button = status.getByRole("button", { name: "Build draft roadmap now" });
  await expect(button).toBeVisible();
  const words = status.locator("> span").first();
  const [w, b] = await Promise.all([words.boundingBox(), button.boundingBox()]);
  expect(b!.y).toBeGreaterThanOrEqual(w!.y + w!.height - 1);
  // Both start at the box's left edge.
  expect(Math.abs(b!.x - w!.x)).toBeLessThanOrEqual(2);

  const publish = page.getByTestId("publish-link").filter({ visible: true });
  await expect(publish).toBeVisible();
  // Its row starts at the page's left edge, as the title and the tabs do.
  const actions = page.getByTestId("doc-header").locator("[data-page-action]");
  const title = page.getByTestId("doc-header").getByRole("heading", { level: 1 });
  const [p, t] = await Promise.all([actions.boundingBox(), title.boundingBox()]);
  expect(Math.abs(p!.x - t!.x)).toBeLessThanOrEqual(2);
});

// --- Present ----------------------------------------------------------------------------------

async function openPresent(page: Page) {
  await login(page);
  await page.goto(`${DOC}/v/2`);
  await page.getByRole("link", { name: "Present" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/documents\/saved-carts\/v\/2\/present$/);
  await expect(page.getByTestId("slide-counter")).toHaveText("1 / 10");
}

test("qa-docs-10: on a phone the slide fills the width and its words are readable", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openPresent(page);
  const view = page.getByTestId("audience-view");
  const slide = (await view.locator(".current-slide").boundingBox())!;
  expect(slide.width).toBeGreaterThanOrEqual(PHONE.width - 24);
  expect(slide.height).toBeGreaterThan(slide.width);
  for (const sel of [".slide-kicker", ".slide-subtitle", ".slide-banner", ".slide-title"]) {
    const part = view.locator(sel).first();
    await expect(part).toBeVisible();
    expect(await fontPx(part), sel).toBeGreaterThanOrEqual(12);
    const box = (await part.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  }
  // A later slide too.
  await page.getByRole("button", { name: "Next slide" }).click();
  await expect(page.getByTestId("slide-counter")).toHaveText("2 / 10");
  expect(await fontPx(view.locator(".slide-title").first())).toBeGreaterThanOrEqual(20);
});

test("qa-docs-63: a PRD's slide says PRD, Full screen once, one counter in the app font", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openPresent(page);
  const view = page.getByTestId("audience-view");
  expect(((await view.locator(".slide-kicker").textContent()) ?? "").trim()).toBe("PRD");

  const full = page.getByRole("button", { name: "Full screen" });
  await expect(full).toHaveAttribute("title", "Shortcut: F");
  await expect(page.getByTestId("present-keys")).not.toContainText("Full screen");
  await expect(page.getByRole("navigation", { name: "Presentation" }).getByText("Full screen", { exact: true })).toHaveCount(1);

  const counter = page.getByTestId("slide-counter");
  expect(await counter.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  await expect(view.locator(".slide-number")).toBeHidden();
  await expect(page.getByText("1 / 10", { exact: true }).filter({ visible: true })).toHaveCount(1);
});

// --- Diff -------------------------------------------------------------------------------------

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-50 (${scheme}): added words read at 4.5:1 or more`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: scheme });
    await login(page);
    await page.goto(`${DOC}/diff?from=1&to=2`);
    const ins = page.getByTestId("word-diff").locator("ins");
    await expect(ins.first()).toBeVisible();
    for (const el of await ins.all()) expect(await contrast(el)).toBeGreaterThanOrEqual(4.5);
  });
}

test("qa-docs-51: on a phone the From and To pickers are labelled and stacked", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page);
  await page.goto(`${DOC}/diff?from=1&to=2`);
  await expect(page.getByRole("heading", { name: "Changes from v1 to v2" })).toBeVisible();
  const pickers = page.getByTestId("diff-pickers");
  await expect(pickers.getByText("From", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(pickers.getByText("To", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(pickers.getByText("→")).toBeHidden();
  const [from, to] = await Promise.all([pickers.getByLabel("From").boundingBox(), pickers.getByLabel("To").boundingBox()]);
  expect(to!.y).toBeGreaterThanOrEqual(from!.y + from!.height);
  expect(from!.x + from!.width).toBeLessThanOrEqual(PHONE.width);
});
