// MOCK-HOOK (GM1 mock-ups, never merged): each frame as a static HTML file (stylesheets inlined,
// scripts removed, fonts in assets/, a ?theme=light|dark hook) and a PNG.
import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(__dirname, "../../../mockups-out/mk-goalmap");
const STORY: Record<string, string> = { a: "propose", b: "goal", c: "attach", d: "prd" };
const ONLY = (process.env.GM_ONLY ?? "").split(",").filter(Boolean);

type Frame = { name: string; q: string; act?: "save"; w: number; h: number };
function frames(): Frame[] {
  const out: Frame[] = [];
  for (const x of "abcd") {
    const e = STORY[x];
    const ex = x === "d" ? "&pick=m4" : "";
    const hard = `?gm1=${x}&data=hard${x === "d" ? "&pick=m10" : ""}`;
    out.push(
      { name: `gm1-${x}-rest`, q: `?gm1=${x}`, w: 1440, h: 900 },
      { name: `gm1-${x}-open`, q: `?gm1=${x}${ex}&open=${e}`, w: 1440, h: 900 },
      { name: `gm1-${x}-mid`, q: `?gm1=${x}${ex}&open=${e}&phase=mid`, w: 1440, h: 900 },
      { name: `gm1-${x}-result`, q: `?gm1=${x}${ex}&open=${e}&phase=mid`, act: "save", w: 1440, h: 900 },
      { name: `gm1-${x}-hard`, q: hard, w: 1440, h: 900 },
      { name: `gm1-${x}-hard-1512`, q: hard, w: 1512, h: 945 },
      { name: `gm1-${x}-phone-390`, q: `?gm1=${x}${ex}`, w: 390, h: 844 },
    );
  }
  return out.filter((f) => !ONLY.length || ONLY.some((o) => f.name.includes(o)));
}

async function snap(page: Page, w: number, h: number) {
  return page.evaluate(([w, h]) => {
    for (const el of Array.from(document.querySelectorAll("input,textarea")) as HTMLInputElement[]) {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) el.setAttribute("checked", "");
        else el.removeAttribute("checked");
      } else el.setAttribute("value", el.value);
    }
    for (const s of Array.from(document.querySelectorAll("select")))
      for (const o of Array.from(s.options)) {
        if (o.selected) o.setAttribute("selected", "");
        else o.removeAttribute("selected");
      }
    for (const el of Array.from(document.querySelectorAll("*"))) if (el.scrollLeft || el.scrollTop) el.setAttribute("data-mk-scroll", `${el.scrollLeft},${el.scrollTop}`);
    if (scrollY) document.documentElement.setAttribute("data-mk-win", String(scrollY));
    let css = "";
    for (const sh of Array.from(document.styleSheets)) {
      try {
        for (const r of Array.from(sh.cssRules)) css += r.cssText + "\n";
      } catch {}
    }
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    doc.querySelectorAll('script, link[rel="stylesheet"], link[rel="preload"], link[as], style, next-route-announcer, nextjs-portal').forEach((n) => n.remove());
    doc.removeAttribute("data-theme");
    const head = doc.querySelector("head")!;
    const meta = document.createElement("meta");
    meta.setAttribute("name", "mockup-viewport");
    meta.setAttribute("content", `${w}x${h}`);
    head.prepend(meta);
    const cs = document.createElement("meta");
    cs.setAttribute("charset", "utf-8");
    head.prepend(cs);
    const st = document.createElement("style");
    st.textContent = "__CSS__";
    head.append(st);
    const sc = document.createElement("script");
    sc.textContent =
      "(function(){var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);" +
      "addEventListener('load',function(){document.querySelectorAll('[data-mk-scroll]').forEach(function(e){var p=e.getAttribute('data-mk-scroll').split(',');e.scrollLeft=+p[0];e.scrollTop=+p[1];});" +
      "var y=document.documentElement.getAttribute('data-mk-win');if(y)scrollTo(0,+y);});})();";
    head.append(sc);
    return { html: "<!doctype html>\n" + doc.outerHTML, css, height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth };
  }, [w, h] as const);
}

test("capture the goal map frames", async ({ browser, baseURL }) => {
  fs.mkdirSync(`${OUT}/frames`, { recursive: true });
  fs.mkdirSync(`${OUT}/assets`, { recursive: true });
  const metaFile = `${OUT}/../../web/scripts/mk-goalmap/frames-meta.json`;
  const meta: Record<string, unknown> = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  const fonts = new Set<string>();
  for (const f of frames()) {
    const phone = f.w === 390;
    const ctx = await browser.newContext({ viewport: { width: f.w, height: f.h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, baseURL });
    const page = await ctx.newPage();
    await page.goto("/login?next=%2Fsimple%2Fgoals");
    await page.getByLabel("Email").fill("admin@example.com");
    await page.getByLabel("Password").fill("demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/simple\/goals/);
    await page.goto(`/simple/goals${f.q}`);
    await page.waitForSelector('[data-testid="gm-page"]');
    await page.waitForTimeout(900);
    if (f.act === "save") {
      await page.getByTestId("gm-save").click();
      await page.waitForTimeout(900);
    }
    if (process.env.GM_DEBUG)
      console.log(await page.evaluate(() => Array.from(document.querySelectorAll("body *")).filter((e) => e.getBoundingClientRect().right > 391).slice(-6).map((e) => `${e.tagName}.${(e.getAttribute("class") ?? "").slice(0, 80)} ${Math.round(e.getBoundingClientRect().right)} ${(e.textContent ?? "").slice(0, 40)}`).join("\n")));
    const r = await snap(page, f.w, f.h);
    let css = r.css;
    const urls = [...css.matchAll(/url\(([^)]+\.(?:woff2?|ttf|otf)[^)]*)\)/g)].map((m) => m[1]);
    for (const raw of new Set(urls)) {
      const u = raw.replace(/^['"]|['"]$/g, "");
      if (u.startsWith("data:")) continue;
      const abs = new URL(u, `${baseURL}/_next/static/css/`).toString();
      const fn = path.basename(abs.split("?")[0]);
      if (!fonts.has(fn)) {
        const res = await page.request.get(abs);
        fs.writeFileSync(`${OUT}/assets/${fn}`, await res.body());
        fonts.add(fn);
      }
      css = css.split(raw).join(`../assets/${fn}`);
    }
    fs.writeFileSync(`${OUT}/frames/${f.name}.html`, r.html.replace("__CSS__", css.replace(/<\/style/g, "<\\/style")));
    await page.screenshot({ path: `${OUT}/frames/${f.name}.png` });
    meta[f.name] = { height: r.height, width: r.width, q: f.q, act: f.act ?? null };
    console.log(f.name, r.height, r.width);
    await ctx.close();
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
});
