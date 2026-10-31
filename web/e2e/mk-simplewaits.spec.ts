// MOCK-HOOK: the whole file. SW1 mock-up frames (Simple Home when a run waits on you), not a test of the product.
// Snapshots each frame as a static html (inlined styles, no scripts, fonts in assets/) and a png, into
// ../mockups-out/mk-simplewaits/frames. Run: MK=1 npx playwright test e2e/mk-simplewaits.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./test";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-simplewaits"); // MOCK-HOOK
const FRAMES = path.join(OUT, "frames"); // MOCK-HOOK
const ASSETS = path.join(OUT, "assets"); // MOCK-HOOK
const ONLY = process.env.MK_ONLY ? new RegExp(process.env.MK_ONLY) : null; // MOCK-HOOK

test.skip(process.env.MK !== "1", "mock-up frames only"); // MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK: scrollbars shown

const GRAB = async () => {
  const css: string[] = [];
  for (const sh of Array.from(document.styleSheets)) {
    try {
      const base = sh.href ?? location.href;
      css.push(Array.from(sh.cssRules).map((r) => r.cssText).join("\n").replace(/url\("?(?!data:|#)([^")]+)"?\)/g, (_m, u: string) => `url("${new URL(u, base).href}")`));
    } catch {
      /* cross-origin */
    }
  }
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  const live = document.documentElement.querySelectorAll("input, textarea");
  const cl = root.querySelectorAll("input, textarea");
  live.forEach((n, i) => {
    const c = cl[i];
    if (!c) return;
    if (n.tagName === "TEXTAREA") c.textContent = (n as HTMLTextAreaElement).value;
    else c.setAttribute("value", (n as HTMLInputElement).value);
  });
  root.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, next-route-announcer, noscript").forEach((n) => n.remove());
  for (const im of Array.from(root.querySelectorAll("img"))) {
    const src = im.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    try {
      const b = await (await fetch(src)).blob();
      const u = await new Promise<string>((r) => {
        const f = new FileReader();
        f.onload = () => r(String(f.result));
        f.readAsDataURL(b);
      });
      im.setAttribute("src", u);
      im.removeAttribute("srcset");
    } catch {
      /* keep */
    }
  }
  // Scroll positions of the window and of scrolled panels, as data- attributes the frame restores.
  const all = document.documentElement.querySelectorAll("*");
  const call = root.querySelectorAll("*");
  all.forEach((n, i) => {
    if ((n.scrollTop || n.scrollLeft) && call[i]) call[i].setAttribute("data-mk-scroll", `${n.scrollLeft},${n.scrollTop}`);
  });
  return { html: root.outerHTML, css: css.join("\n"), sx: scrollX, sy: scrollY };
};

const THEME = `<script>/* mock-up theme hook: ?theme=light|dark */(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);})();</script>`;

async function snap(page: Page, name: string) {
  if (ONLY && !ONLY.test(name)) return;
  await page.waitForTimeout(600);
  const vp = page.viewportSize()!;
  const g = await page.evaluate(GRAB);
  let css = g.css;
  const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]))];
  for (const raw of urls) {
    const url = raw.replace(/^['"]|['"]$/g, "");
    if (url.startsWith("data:") || url.startsWith("#")) continue;
    const file = path.basename(url.split("?")[0]);
    const dest = path.join(ASSETS, file);
    if (!fs.existsSync(dest)) {
      const r = await page.request.get(new URL(url, page.url()).toString());
      if (!r.ok()) continue;
      fs.writeFileSync(dest, await r.body());
    }
    css = css.split(`url(${raw})`).join(`url("../assets/${file}")`);
  }
  const restore = `<script>/* restore scroll */addEventListener("load",function(){document.querySelectorAll("[data-mk-scroll]").forEach(function(n){var p=n.getAttribute("data-mk-scroll").split(",");n.scrollLeft=+p[0];n.scrollTop=+p[1];});scrollTo(${g.sx},${g.sy});});</script>`;
  const head = `<meta charset="utf-8"><meta name="mockup-viewport" content="${vp.width}x${vp.height}"><meta name="viewport" content="width=${vp.width}">${THEME}<style>${css}</style>`;
  const html = `<!doctype html>${g.html.replace(/<head>/, `<head>${head}`).replace(/<\/body>/, `${restore}</body>`)}`;
  fs.writeFileSync(path.join(FRAMES, `${name}.html`), html);
  await page.screenshot({ path: path.join(FRAMES, `${name}.png`) });
}

const DESK = { width: 1440, height: 900 };
const WIDE = { width: 1512, height: 982 };
const PHONE = { width: 390, height: 844 };

async function signIn(page: Page, size: { width: number; height: number }) {
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.setViewportSize(size);
  await page.context().addInitScript(() => {
    if (!sessionStorage.getItem("mk")) {
      localStorage.removeItem("po-mock-db-v2");
      sessionStorage.setItem("mk", "1");
    }
    localStorage.setItem("po-mock-scenario", "simple-waits");
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.MK_USER ?? "admin@example.com");
  await page.getByLabel("Password").fill(["de", "mo"].join(""));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const simple = (page: Page) => page.getByTestId("simple-page");

async function home(page: Page, q: string) {
  await page.goto(`/simple?${q}`);
  await expect(simple(page).getByTestId("home-sentence")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
}

export { DESK, WIDE, PHONE, signIn, snap, home, simple };

test.describe.configure({ mode: "serial" });

const CALM = "calm=1"; // MOCK-HOOK: nothing but runs waits on the person
const stopCards = (page: Page) => simple(page).getByTestId("sw-stop-card");

async function atRun(page: Page) {
  await page.waitForURL(/\/runs\//);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
}

/** MOCK-HOOK: hovers, then bakes the hover's look into inline styles so the static frame keeps it. */
async function hoverBaked(page: Page, loc: ReturnType<Page["locator"]>) {
  await loc.hover();
  await page.waitForTimeout(400);
  await loc.evaluate((el: HTMLElement) => {
    // The page's :hover rules, again for [data-mk-hover], so the frame keeps the hover in either theme.
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule && r.cssText.includes(":hover")) out.push(r.cssText.replace(/:hover/g, "[data-mk-hover]"));
        else if (r instanceof CSSMediaRule && /hover/.test(r.conditionText)) walk(r.cssRules);
        else if ("cssRules" in r && !(r instanceof CSSMediaRule) && !(r instanceof CSSStyleRule)) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sh of Array.from(document.styleSheets)) {
      try {
        walk(sh.cssRules);
      } catch {
        /* cross-origin */
      }
    }
    const st = document.createElement("style");
    st.textContent = out.join("\n");
    document.head.appendChild(st);
    el.setAttribute("data-mk-hover", "1");
  });
}

async function scrollTo(page: Page, testId: string) {
  await simple(page).getByTestId(testId).first().evaluate((n) => n.scrollIntoView({ block: "start" }));
  await page.evaluate(() => scrollBy(0, -24));
}

test("A: a card per stop", async ({ page }) => {
  await signIn(page, DESK);
  await home(page, `sw1=a&swn=0&${CALM}`);
  await snap(page, "sw1-a-zero");
  await home(page, `sw1=a&swn=1&${CALM}`);
  await snap(page, "sw1-a-one");
  await home(page, `sw1=a&swn=3&${CALM}`);
  await snap(page, "sw1-a-rest");
  await scrollTo(page, "sw-stop-card");
  const btn = stopCards(page).nth(1).getByRole("link");
  await hoverBaked(page, btn);
  await snap(page, "sw1-a-hover");
  await btn.click();
  await atRun(page);
  await snap(page, "sw1-a-result");
});

test("A: wide and phone", async ({ page }) => {
  await signIn(page, WIDE);
  await home(page, "sw1=a&swn=3");
  await scrollTo(page, "home-summary");
  await snap(page, "sw1-a-rest-1512");
  await page.setViewportSize(PHONE);
  await home(page, `sw1=a&swn=3&${CALM}`);
  await scrollTo(page, "sw-stop-card");
  await snap(page, "sw1-a-rest-390");
});

test("B: one line to Detailed", async ({ page }) => {
  await signIn(page, DESK);
  await home(page, `sw1=b&swn=1&${CALM}`);
  await snap(page, "sw1-b-one");
  await home(page, `sw1=b&swn=3&${CALM}`);
  await snap(page, "sw1-b-rest");
  const link = simple(page).getByTestId("sw-runs-line").getByRole("link");
  await hoverBaked(page, link);
  await snap(page, "sw1-b-hover");
  await link.click();
  await page.waitForURL(/\/home/);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByTestId("home-in-flight").evaluate((n) => n.scrollIntoView({ block: "center" })).catch(() => undefined);
  await snap(page, "sw1-b-result");
});

test("B: wide and phone", async ({ page }) => {
  await signIn(page, WIDE);
  await home(page, "sw1=b&swn=3");
  await snap(page, "sw1-b-rest-1512");
  await page.setViewportSize(PHONE);
  await home(page, `sw1=b&swn=3&${CALM}`);
  await scrollTo(page, "sw-runs-line");
  await snap(page, "sw1-b-rest-390");
});

test("C: in Decisions", async ({ page }) => {
  await signIn(page, DESK);
  await home(page, `sw1=c&swn=1&${CALM}`);
  await snap(page, "sw1-c-one");
  await home(page, `sw1=c&swn=3&${CALM}`);
  await snap(page, "sw1-c-rest");
  // The rail's Decisions (its link does not carry the mock-up's switches, so the address does).
  await page.goto(`/simple/decisions?sw1=c&swn=3&${CALM}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  await snap(page, "sw1-c-open");
  const act = simple(page).getByTestId("sw-stop-row").getByRole("link", { name: "Check the engineering review" });
  await hoverBaked(page, act);
  await snap(page, "sw1-c-hover");
  await act.click();
  await atRun(page);
  await snap(page, "sw1-c-result");
});

test("C: wide and phone", async ({ page }) => {
  await signIn(page, WIDE);
  await page.goto("/simple/decisions?sw1=c&swn=3");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await snap(page, "sw1-c-open-1512");
  await page.setViewportSize(PHONE);
  await home(page, `sw1=c&swn=3&${CALM}`);
  await scrollTo(page, "home-decisions");
  await snap(page, "sw1-c-rest-390");
});

test("D: a run tray in the rail", async ({ page }) => {
  await signIn(page, DESK);
  await home(page, `sw1=d&swn=0&${CALM}`);
  await page.getByTestId("sw-tray-button").click();
  await page.mouse.move(900, 880); // MOCK-HOOK: the pointer off the rail, so the frame shows the open state, not the hover
  await snap(page, "sw1-d-zero");
  await home(page, `sw1=d&swn=1&${CALM}`);
  await snap(page, "sw1-d-one");
  await home(page, `sw1=d&swn=3&${CALM}`);
  await snap(page, "sw1-d-rest");
  await page.getByTestId("sw-tray-button").click();
  await page.mouse.move(900, 880); // MOCK-HOOK: the pointer off the rail, so the frame shows the open state, not the hover
  await snap(page, "sw1-d-open");
  const act = page.getByTestId("sw-tray").getByRole("link").first();
  await hoverBaked(page, act);
  await snap(page, "sw1-d-hover");
  await act.click();
  await atRun(page);
  await snap(page, "sw1-d-result");
});

test("D: wide and phone", async ({ page }) => {
  await signIn(page, WIDE);
  await home(page, "sw1=d&swn=3");
  await page.getByTestId("sw-tray-button").click();
  await page.mouse.move(900, 880); // MOCK-HOOK: the pointer off the rail, so the frame shows the open state, not the hover
  await snap(page, "sw1-d-open-1512");
  await page.setViewportSize(PHONE);
  await home(page, `sw1=d&swn=3&${CALM}`);
  await snap(page, "sw1-d-rest-390");
  await page.getByTestId("sw-tray-chip").click();
  await snap(page, "sw1-d-open-390");
});
