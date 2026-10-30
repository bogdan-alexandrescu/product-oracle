import { THEME_KEY } from "../lib/theme";
import { login, openRoadmapItem, signOut } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * fix4, the roadmap's roles and its frame: qa-simple-roadmap-9 (a commenter acts on the version
 * their roadmap shows, not the owner's working draft), 46 (the rail runs the page's height and
 * dims with it), 51 (an email wraps between its parts), 47 (Comment in the opened flow), 48 (the
 * full-screen flow's scrollbar in dark mode) and 53 (storyboard cards as tall as their words).
 * Driven against the mock's default scenario (Weekly alert digest starts before Alert rules
 * engine, which it depends on, ends; Alert history export's first drawing fails, Retry draws it).
 */

const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const callout = (page: Page, key: string): Locator => page.locator(`[data-testid="broken-callout"][data-item="${key}"]`).first();

async function theme(page: Page, scheme: "light" | "dark") {
  await page.context().addInitScript(([key, value]) => localStorage.setItem(key, value), [THEME_KEY, scheme] as const);
  await page.emulateMedia({ colorScheme: scheme });
}

async function openRoadmap(page: Page, email?: string) {
  await login(page, email);
  await page.goto("/simple/roadmap");
  await expect(page.getByTestId("simple-roadmap")).toBeVisible();
}

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

/** An item's card. On a desktop its bar is focused and opened with Enter (as a keyboard user
 * does): the quarter columns' drop targets cover the bars for a pointer in the current build. */
async function openItem(page: Page, key: string) {
  if ((page.viewportSize()?.width ?? 1440) <= 640) return openRoadmapItem(page, key);
  const bar = page.locator(`g[data-testid="bar"][data-item="${key}"]`);
  await expect(bar).toBeVisible();
  await bar.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("floating-card")).toBeVisible();
}

/** Alert history export's card with its flow drawn (the first drawing fails; Retry draws it). */
async function drawnExport(page: Page): Promise<Locator> {
  await openRoadmap(page);
  await openItem(page, "alert-export");
  const row = page.getByTestId("floating-card").getByTestId("flow-row");
  await tap(row.getByRole("button", { name: "Ask Oracle to draw it" }));
  await tap(row.getByRole("button", { name: "Retry" }));
  await expect(row.getByTestId("flow-drawn")).toContainText("Version 1 · drawn");
  return row;
}

test.describe("desktop", () => {
  test.use(DESKTOP);

  test("qa-simple-roadmap-9: a commenter's fix is checked against the roadmap they see, not the owner's draft", async ({ page }) => {
    // The owner moves the digest in their working draft.
    await openRoadmap(page);
    await callout(page, "alert-digest").getByRole("button", { name: "Move the dependents" }).click();
    await expect(page.getByText(/Moved what depends on .Alert rules engine. in your working draft/)).toBeVisible();
    await signOut(page);

    // The commenter still sees the published roadmap: the link is broken there, and its fix is
    // proposed against those dates, not refused as changed since they saw it.
    await openRoadmap(page, "commenter@example.com");
    const fix = callout(page, "alert-digest").getByRole("button", { name: "Move the dependents" });
    await expect(fix).toBeVisible();
    await fix.click();
    await expect(page.getByText(/Moved what depends on .Alert rules engine. proposed: it waits for /)).toBeVisible();
    await expect(page.getByText(/Changed since you saw it/)).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-simple-roadmap-46: the rail runs the page's height and dims with the page under a card (${scheme})`, async ({ page }) => {
      await theme(page, scheme);
      await openRoadmap(page);
      const rail = page.getByTestId("simple-nav");
      const under = page.getByTestId("simple-nav-underlay");
      await expect(under).toBeAttached();
      const sizes = await page.evaluate(() => {
        const u = document.querySelector('[data-testid="simple-nav-underlay"]')!;
        const r = u.getBoundingClientRect();
        return { top: r.top + window.scrollY, height: r.height, page: document.documentElement.scrollHeight };
      });
      expect(Math.round(sizes.top)).toBe(0);
      expect(sizes.height).toBeGreaterThanOrEqual(sizes.page - 1);
      // The same colour as the rail itself.
      const bg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor);
      await expect(under).toHaveCSS("background-color", bg);

      // An item's card dims the rail with the page (its backdrop is over the rail).
      await openItem(page, "alert-rules");
      await expect(page.getByTestId("floating-card")).toBeVisible();
      await expect(page.getByTestId("floating-card-backdrop")).toBeVisible();
      const box = (await rail.boundingBox())!;
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? null, [box.x + box.width / 2, box.y + box.height / 2] as const);
      expect(top).toBe("floating-card-backdrop");
    });
  }

  test("qa-simple-roadmap-51: the viewer's email wraps before its @, never mid-word", async ({ page }) => {
    await openRoadmap(page, "viewer@example.com");
    const name = page.getByTestId("simple-person-name");
    await expect(name).toHaveText("viewer@example.com");
    await expect(name).toHaveAttribute("title", "viewer@example.com");
    // The text as it is laid out, one entry per line.
    const lines = await name.evaluate((el) => {
      const out: { top: number; text: string }[] = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent ?? "";
        for (let i = 0; i < t.length; i++) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          const last = out[out.length - 1];
          if (last && Math.abs(last.top - top) < 4) last.text += t[i];
          else out.push({ top, text: t[i] });
        }
      }
      return out.map((l) => l.text);
    });
    // Train AD's call: the rail's person line breaks before the '@'.
    expect(["viewer@example.com", "viewer|@example.com"]).toContain(lines.join("|"));
  });

  test("qa-simple-roadmap-53: the storyboard's cards are as tall as their words", async ({ page }) => {
    const row = await drawnExport(page);
    await tap(row.getByRole("button", { name: "Open the storyboard" }));
    const cards = page.getByTestId("flow-storyboard").getByTestId("story-card");
    await expect(cards).toHaveCount(6);
    // A one-line step is shorter than the decision with its Yes and No.
    const step = (await cards.nth(0).boundingBox())!;
    const decision = (await cards.nth(2).boundingBox())!;
    expect(step.height).toBeLessThan(decision.height - 20);
    // No card has room left under its words.
    const slack = await cards.nth(0).evaluate((el) => {
      const last = el.lastElementChild!.getBoundingClientRect();
      return el.getBoundingClientRect().bottom - last.bottom;
    });
    expect(slack).toBeLessThanOrEqual(16);
  });
});

for (const [where, use] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test.describe(where, () => {
    test.use(use);

    test(`qa-simple-roadmap-47: Comment opens the comments in the opened flow too (${where})`, async ({ page }) => {
      const row = await drawnExport(page);
      await tap(row.getByRole("button", { name: "Open the flow", exact: true }));
      const opened = page.getByTestId("flow-detail");
      await expect(opened).toBeVisible();
      await tap(opened.getByRole("button", { name: "Comment", exact: true }));
      await expect(opened.getByLabel("Comment on the flow")).toBeVisible();
      await expect(opened.getByTestId("flow-version")).toHaveText("Version 1 of 1");
      // The full-screen viewer keeps its own Comment.
      await tap(opened.getByRole("button", { name: "Full screen" }));
      const viewer = page.getByTestId("flow-fullscreen");
      await expect(viewer.getByRole("button", { name: "Comment", exact: true }).first()).toBeVisible();
    });
  });
}

test.describe("phone, dark", () => {
  test.use(PHONE);

  test("qa-simple-roadmap-48: the full-screen flow scrolls with a dark scrollbar and readable steps", async ({ page }) => {
    await theme(page, "dark");
    const row = await drawnExport(page);
    await tap(row.getByRole("button", { name: "Open the flow", exact: true }));
    await tap(page.getByTestId("flow-detail").getByRole("button", { name: "Full screen" }));
    const viewer = page.getByTestId("flow-fullscreen");
    await expect(viewer).toBeVisible();
    await tap(viewer.getByRole("tab", { name: "Steps" }));
    await expect(viewer.getByTestId("flow-steps")).toContainText("the sign-in page opens");
    const look = await viewer.evaluate((root) => {
      const pane = [...root.querySelectorAll<HTMLElement>("div")].find((el) => getComputedStyle(el).overflowY === "auto")!;
      const surface = getComputedStyle(root).backgroundColor;
      return { scrollbar: getComputedStyle(pane).scrollbarColor, surface };
    });
    // The track is the dark surface, not the browser's light grey.
    expect(look.scrollbar).toContain(look.surface);
    expect(look.surface).toBe("rgb(12, 26, 46)");
    // The steps' words on their boxes: at least 4.5:1.
    const ratios = await viewer.getByTestId("flow-steps").evaluate((ol) => {
      const lum = (c: string) => {
        const [r, g, b] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return [...ol.querySelectorAll<HTMLElement>("li > span:last-child")].map((box) => {
        const fg = lum(getComputedStyle(box).color);
        const bg = lum(getComputedStyle(box).backgroundColor);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
    });
    expect(ratios.length).toBeGreaterThan(0);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
});
