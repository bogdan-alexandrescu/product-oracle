// MOCK-HOOK: the whole file. mk-goalorder mock-up frames: drives the mock app's UI through each
// proposal's story and saves every frame as a static html file (DOM cloned, stylesheets inlined,
// scripts removed, fonts copied to assets/) and a PNG. Run: MK_FRAMES=1 E2E_PORT=3393 npx playwright
// test e2e/mk-goalorder-frames.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { login } from "./helpers";
import { expect, test, type Page } from "./test";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-goalorder");
const FRAMES = path.join(OUT, "frames");
const ASSETS = path.join(OUT, "assets");
const ONLY = process.env.MK_ONLY ?? "";

test.skip(!process.env.MK_FRAMES, "mock-up frames only"); // MOCK-HOOK
test.use({ launchOptions: { args: ["--hide-scrollbars=false"], ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK: scrollbars shown
test.setTimeout(600_000);

type Cfg = { go1?: string; go2?: string; goals?: string; role?: string; theme?: "light" | "dark" };
const SIZE = { 1440: { width: 1440, height: 900 }, 1512: { width: 1512, height: 945 }, 390: { width: 390, height: 844 } } as const;

async function start(page: Page, cfg: Cfg, w: keyof typeof SIZE = 1440) {
  await page.setViewportSize(SIZE[w]);
  await page.goto("/login");
  await page.evaluate((c) => {
    localStorage.clear();
    localStorage.setItem("mk-goalorder", JSON.stringify({ go1: c.go1, go2: c.go2, goals: c.goals }));
    localStorage.setItem("oracle-theme", c.theme ?? "light");
    if (c.role) localStorage.setItem("po-mock-role", c.role);
  }, cfg);
  await login(page);
  await page.waitForURL(/\/home|\/simple/);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => {
    localStorage.setItem("oracle-theme", t);
    document.documentElement.dataset.theme = t;
  }, theme);
}

async function open(page: Page, url: string, ready: string) {
  await page.goto(url);
  await page.locator(ready).first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

const fontsDone = new Map<string, string>();

/** The frame: the page's DOM as one static html file, and its PNG. */
async function snap(page: Page, name: string) {
  if (ONLY && !name.startsWith(ONLY)) return;
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.waitForTimeout(300);
  const vp = page.viewportSize()!;
  const got = await page.evaluate(() => {
    const css = [...document.styleSheets]
      .map((s) => {
        try {
          return [...s.cssRules].map((r) => r.cssText).join("\n");
        } catch {
          return "";
        }
      })
      .join("\n");
    // Scroll places, kept on the elements so the frame opens where the page was.
    document.querySelectorAll("*").forEach((el) => {
      if (el.scrollTop > 0 || el.scrollLeft > 0) el.setAttribute("data-mk-scroll", `${el.scrollLeft},${el.scrollTop}`);
    });
    document.querySelectorAll("input, textarea").forEach((el) => el.setAttribute("value", (el as HTMLInputElement).value));
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    document.querySelectorAll("[data-mk-scroll]").forEach((el) => el.removeAttribute("data-mk-scroll"));
    doc.querySelectorAll("script, style, link, noscript, next-route-announcer").forEach((n) => n.remove());
    doc.querySelectorAll("img[src^='/']").forEach((n) => n.setAttribute("src", location.origin + n.getAttribute("src")));
    return { html: doc.outerHTML, css, x: window.scrollX, y: window.scrollY, theme: document.documentElement.dataset.theme ?? "light" };
  });
  let css = got.css;
  for (const m of [...css.matchAll(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\)/g)]) {
    const src = m[1];
    if (!fontsDone.has(src)) {
      const file = path.basename(src.split("?")[0]);
      const res = await page.request.get(new URL(src, page.url()).toString());
      fs.writeFileSync(path.join(ASSETS, file), await res.body());
      fontsDone.set(src, `../assets/${file}`);
    }
    css = css.split(src).join(fontsDone.get(src)!);
  }
  const head =
    `<meta charset="utf-8"><meta name="mockup-viewport" content="${vp.width}x${vp.height}">` +
    `<meta name="viewport" content="width=${vp.width}"><style>${css}</style>` +
    // The ?theme=light|dark hook, and the page's scroll places.
    `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);` +
    `addEventListener("load",function(){document.querySelectorAll("[data-mk-scroll]").forEach(function(e){var p=e.getAttribute("data-mk-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1]});scrollTo(${got.x},${got.y})})})()</script>`;
  const html = "<!doctype html>\n" + got.html.replace(/<head[^>]*>/, (h) => h + head);
  fs.writeFileSync(path.join(FRAMES, `${name}.html`), html);
  await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
}

/** Home and Roadmap side by side, each at its own full width, as one frame. */
async function sideBySide(page: Page, name: string, query: string) {
  if (ONLY && !name.startsWith(ONLY)) return;
  await open(page, `/simple?${query}`, "[data-testid=home-goal]");
  await page.locator("[data-testid=home-goals]").scrollIntoViewIfNeeded();
  await snap(page, `${name}-home`);
  await open(page, `/simple/roadmap?${query}`, "[data-testid=simple-chart]");
  await snap(page, `${name}-roadmap`);
  const vp = page.viewportSize()!;
  const wrap = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="mockup-viewport" content="${vp.width}x${vp.height}">
<style>html,body{margin:0;background:#c9d3de}html[data-theme=dark],html[data-theme=dark] body{background:#08111f}.row{display:flex;gap:16px;padding:16px;box-sizing:border-box;height:100vh}
.pane{flex:1;position:relative;overflow:hidden;border-radius:10px;box-shadow:0 4px 18px rgb(0 0 0/.25)}iframe{border:0;width:${vp.width}px;height:${vp.height * 2 - 64}px;transform:scale(0.4889);transform-origin:0 0;position:absolute}</style>
<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);addEventListener("load",function(){if(t)document.querySelectorAll("iframe").forEach(function(f){f.src=f.getAttribute("src").split("?")[0]+"?theme="+t})})})()</script></head>
<body><div class="row"><div class="pane"><iframe src="${name}-home.html" title="Home"></iframe></div><div class="pane"><iframe src="${name}-roadmap.html" title="Roadmap"></iframe></div></div></body></html>`;
  fs.writeFileSync(path.join(FRAMES, `${name}.html`), wrap);
  const shot = await page.context().newPage();
  await shot.setViewportSize(vp);
  await shot.goto("file://" + path.join(FRAMES, `${name}.html`));
  await shot.waitForTimeout(1200);
  await shot.screenshot({ path: path.join(FRAMES, `${name}.png`) });
  await shot.close();
}

const resetOrder = (page: Page) =>
  page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("mk-goalorder") ?? "{}");
    delete c.order;
    localStorage.setItem("mk-goalorder", JSON.stringify(c));
  });

const goalsTable = async (page: Page) => {
  await page.locator("[data-testid^=goal-g]").first().scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const t = document.querySelector("[data-testid^=goal-g]")?.closest("table");
    t?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -140);
    const main = t?.closest("main");
    if (main && main.scrollTop > 0) main.scrollTop -= 140;
  });
};

// ------------------------------------------------------------------ GO1 a: Baseline handles
test("go1-a", async ({ page }) => {
  await start(page, { go1: "a" });
  const base = "/baseline?tab=graph&go1=a";
  await open(page, base, "[data-testid=mk-handle]");
  await goalsTable(page);
  await snap(page, "go1-a-rest");
  await open(page, `/simple?go1=a`, "[data-testid=home-goal]");
  await snap(page, "go1-a-cost");
  await open(page, base, "[data-testid=mk-handle]");
  await goalsTable(page);
  await page.getByRole("button", { name: "Move Grow paid conversion" }).click();
  await snap(page, "go1-a-open");
  await open(page, `${base}&phase=mid`, "[data-testid=mk-handle]");
  await goalsTable(page);
  await snap(page, "go1-a-mid");
  await open(page, base, "[data-testid=mk-handle]");
  await page.getByRole("button", { name: "Move Grow paid conversion" }).click();
  await page.getByRole("menuitem", { name: "Make it goal 1" }).click();
  await expect(page.getByText("Grow paid conversion is now goal 1 of 5")).toBeVisible();
  await goalsTable(page);
  await snap(page, "go1-a-saved");
  await sideBySide(page, "go1-a-result", "go1=a");
  await resetOrder(page);
  await start(page, { go1: "a", goals: "9" }, 1512);
  await open(page, `${base}&goals=9`, "[data-testid=mk-handle]");
  await goalsTable(page);
  await page.getByRole("button", { name: "Move Faster page loads" }).click();
  await snap(page, "go1-a-hard-1512");
  await page.setViewportSize(SIZE[390]);
  await open(page, `${base}&goals=9`, "[data-testid=mk-handle]");
  await goalsTable(page);
  await snap(page, "go1-a-phone-390");
  await page.setViewportSize(SIZE[1440]);
  await setTheme(page, "dark");
  await open(page, base, "[data-testid=mk-handle]");
  await goalsTable(page);
  await page.getByRole("button", { name: "Move Grow paid conversion" }).click();
  await snap(page, "go1-a-dark");
});

// ------------------------------------------------------------------ GO1 b: right in Home's goal row
test("go1-b", async ({ page }) => {
  await start(page, { go1: "b" });
  await open(page, "/simple?go1=b", "[data-testid=mk-change-order]");
  await snap(page, "go1-b-rest");
  await page.getByTestId("mk-change-order").click();
  await snap(page, "go1-b-open");
  await open(page, "/simple?go1=b&open=1&phase=mid", "[data-testid=mk-edit-goal]");
  await snap(page, "go1-b-mid");
  await open(page, "/simple?go1=b", "[data-testid=mk-change-order]");
  await page.getByTestId("mk-change-order").click();
  await page.getByRole("button", { name: "Move Grow paid conversion left" }).click();
  await page.getByRole("button", { name: "Move Grow paid conversion left" }).click();
  await page.getByTestId("mk-save-order").click();
  await expect(page.getByText("Goal order saved.")).toBeVisible();
  await snap(page, "go1-b-saved");
  await sideBySide(page, "go1-b-result", "go1=b");
  await resetOrder(page);
  await start(page, { go1: "b", role: "viewer" });
  await open(page, "/simple?go1=b", "[data-testid=home-goal]");
  await snap(page, "go1-b-viewer");
  await start(page, { go1: "b", goals: "9" }, 1512);
  await open(page, "/simple?go1=b&goals=9&open=1", "[data-testid=mk-edit-goal]");
  await snap(page, "go1-b-hard-1512");
  await page.setViewportSize(SIZE[390]);
  await open(page, "/simple?go1=b&open=1", "[data-testid=mk-edit-goal]");
  await page.getByTestId("mk-home-edit").scrollIntoViewIfNeeded();
  await snap(page, "go1-b-phone-390");
  await page.setViewportSize(SIZE[1440]);
  await setTheme(page, "dark");
  await open(page, "/simple?go1=b&open=1&phase=mid", "[data-testid=mk-edit-goal]");
  await snap(page, "go1-b-dark");
});

// ------------------------------------------------------------------ GO1 c: an order dialog with arrows
test("go1-c", async ({ page }) => {
  await start(page, { go1: "c" });
  await open(page, "/simple?go1=c", "[data-testid=mk-change-order]");
  await snap(page, "go1-c-rest");
  await page.getByTestId("mk-change-order").click();
  await snap(page, "go1-c-open");
  await open(page, "/simple?go1=c&open=1&phase=mid", "[data-testid=mk-order-dialog]");
  await snap(page, "go1-c-mid");
  await open(page, "/simple?go1=c", "[data-testid=mk-change-order]");
  await page.getByTestId("mk-change-order").click();
  await page.getByRole("button", { name: "Move Grow paid conversion up" }).click();
  await page.getByRole("button", { name: "Move Grow paid conversion up" }).click();
  await page.getByTestId("mk-save-order").click();
  await expect(page.getByText("Goal order saved.")).toBeVisible();
  await snap(page, "go1-c-saved");
  await sideBySide(page, "go1-c-result", "go1=c");
  await resetOrder(page);
  await start(page, { go1: "c", goals: "9" }, 1512);
  await open(page, "/simple?go1=c&goals=9&open=1", "[data-testid=mk-order-dialog]");
  await snap(page, "go1-c-hard-1512");
  await page.setViewportSize(SIZE[390]);
  await open(page, "/simple?go1=c&open=1&phase=mid", "[data-testid=mk-order-dialog]");
  await snap(page, "go1-c-phone-390");
  await page.setViewportSize(SIZE[1440]);
  await setTheme(page, "dark");
  await open(page, "/simple?go1=c&open=1&phase=mid", "[data-testid=mk-order-dialog]");
  await snap(page, "go1-c-dark");
});

// ------------------------------------------------------------------ GO1 d: Move left / Move right on a goal's own panel
test("go1-d", async ({ page }) => {
  await start(page, { go1: "d" });
  const base = "/baseline?tab=graph&go1=d";
  const openGoal = async (title: string) => {
    await page.locator("[data-testid^=goal-g]", { hasText: title }).first().click();
    await page.getByTestId("mk-place").waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByTestId("mk-place").scrollIntoViewIfNeeded();
  };
  await open(page, base, "[data-testid^=goal-g]");
  await goalsTable(page);
  await snap(page, "go1-d-rest");
  await openGoal("Grow paid conversion");
  await snap(page, "go1-d-open");
  await page.getByTestId("mk-move-left").click();
  await expect(page.getByText("Grow paid conversion is now goal 2 of 5")).toBeVisible();
  await snap(page, "go1-d-mid");
  await page.getByTestId("mk-move-left").click();
  await expect(page.getByText("Grow paid conversion is now goal 1 of 5")).toBeVisible();
  await snap(page, "go1-d-saved");
  await sideBySide(page, "go1-d-result", "go1=d");
  await resetOrder(page);
  await start(page, { go1: "d", goals: "9" }, 1512);
  await open(page, `${base}&goals=9`, "[data-testid^=goal-g]");
  await openGoal("Faster page loads");
  await snap(page, "go1-d-hard-1512");
  await page.setViewportSize(SIZE[390]);
  await open(page, base, "[data-testid^=goal-g]");
  await openGoal("Grow paid conversion");
  await page.getByTestId("mk-place").scrollIntoViewIfNeeded();
  await snap(page, "go1-d-phone-390");
  await page.setViewportSize(SIZE[1440]);
  await setTheme(page, "dark");
  await open(page, base, "[data-testid^=goal-g]");
  await openGoal("Grow paid conversion");
  await snap(page, "go1-d-dark");
});

// ------------------------------------------------------------------ GO2: how a reader sees the order
for (const v of ["a", "b", "c", "d"]) {
  test(`go2-${v}`, async ({ page }) => {
    const q = `go2=${v}`;
    await start(page, { go2: v });
    await open(page, `/simple?${q}`, "[data-testid=home-goal]");
    await snap(page, `go2-${v}-home`);
    await open(page, `/simple/roadmap?${q}`, "[data-testid=simple-chart]");
    await snap(page, `go2-${v}-roadmap`);
    await start(page, { go2: v, goals: "9" }, 1512);
    await open(page, `/simple?${q}&goals=9`, "[data-testid=home-goal]");
    await page.locator("[data-testid=home-goals]").scrollIntoViewIfNeeded();
    await snap(page, `go2-${v}-hard-1512`);
    await page.setViewportSize(SIZE[390]);
    await open(page, `/simple?${q}`, "[data-testid=home-goal]");
    await page.locator("[data-testid=home-goals]").scrollIntoViewIfNeeded();
    await snap(page, `go2-${v}-phone-390`);
    await page.setViewportSize(SIZE[1440]);
    await setTheme(page, "dark");
    await open(page, `/simple/roadmap?${q}`, "[data-testid=simple-chart]");
    await snap(page, `go2-${v}-dark`);
  });
}
