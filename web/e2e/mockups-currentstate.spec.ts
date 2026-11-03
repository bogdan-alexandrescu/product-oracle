// MOCK-HOOK: the whole file. Captures the "Desired state and Current state" mock-up frames
// (mockups-out/mk-currentstate) as static html + png. Runs only with MOCKUPS=1.
import fs from "node:fs";
import path from "node:path";

import { login } from "./helpers";
import { test } from "./test";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-currentstate");
const D = { width: 1440, height: 900 };
const W = { width: 1512, height: 982 };
const P = { width: 390, height: 844 };

type Frame = { file: string; url: string; size: { width: number; height: number }; full?: boolean; focus?: boolean };
const frames: Frame[] = [];
for (const v of ["a", "b", "c"]) {
  const groups: [string, string][] = [
    ["cs1", `/baseline?cs1=${v}`],
    ["cs2", `/simple/priorities?cs2=${v}`],
    ["cs3", `/baseline?cs3=${v}`],
  ];
  for (const [code, url] of groups) {
    for (const phase of ["rest", "open", "mid", "done"]) frames.push({ file: `${code}-${v}-${phase}`, url: `${url}&phase=${phase}&theme=light`, size: D });
    frames.push({ file: `${code}-${v}-hard-1512`, url: `${url}&phase=rest&hard=1&theme=light`, size: W, full: true });
    frames.push({ file: `${code}-${v}-phone-390`, url: `${url}&phase=${code === "cs2" ? "rest" : "open"}&theme=dark`, size: P });
  }
  frames.push({ file: `cs2-${v}-places`, url: `/baseline?cs2=${v}&phase=places&theme=light`, size: D });
  frames.push({ file: `cs2-${v}-places-390`, url: `/baseline?cs2=${v}&phase=places&theme=dark`, size: P });
  frames.push({ file: `cs2-${v}-places-lower-390`, url: `/baseline?cs2=${v}&phase=places&theme=dark`, size: P });
}
if (process.env.MOCKUPS_DARK) frames.push({ file: "cs2-a-rest-dark", url: "/simple/priorities?cs2=a&phase=rest&theme=dark", size: D });

test.describe.configure({ mode: "serial" });
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
test.skip(!process.env.MOCKUPS, "mock-ups only");

test("frames", async ({ page }) => {
  test.setTimeout(40 * 60_000);
  await login(page);
  for (const f of frames) {
    // The timeline's old-proof entry sits low on the page: open, mid, done and phone show it.
    f.focus = (f.file.startsWith("cs1-c-") && !/rest|hard/.test(f.file)) || f.file.includes("places-lower");
    if (process.env.ONLY && !f.file.includes(process.env.ONLY)) continue;
    await page.setViewportSize(f.size);
    await page.goto(f.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    if (f.focus) {
      await page.evaluate(() => document.querySelector("[data-cs-focus]")?.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -90));
      await page.waitForTimeout(200);
    }
    const scrollY = await page.evaluate(() => Math.round(window.scrollY));
    const r = await page.evaluate(() => {
      let css = "";
      for (const s of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(s.cssRules)) css += rule.cssText + "\n";
        } catch {}
      }
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, next-route-announcer, nextjs-portal").forEach((n) => n.remove());
      return { css, html: doc.outerHTML };
    });
    let css = r.css;
    const fonts = [...css.matchAll(/url\(([^)]*\.(?:woff2?|ttf|otf)[^)]*)\)/g)].map((m) => m[1].replace(/["']/g, ""));
    for (const u of new Set(fonts)) {
      const name = path.basename(u.split("?")[0]);
      const dst = path.join(OUT, "assets", name);
      // The built app's own font files: fetching the relative url returned the html page instead.
      const src = path.resolve(__dirname, "../.next-mock/static/media", name);
      if (!fs.existsSync(dst) || fs.readFileSync(dst).subarray(0, 4).toString() !== "wOF2") fs.copyFileSync(src, dst);
      css = css.split(u).join(`../assets/${name}`);
    }
    const head =
      `<meta name="mockup-viewport" content="${f.size.width}x${f.size.height}">` +
      `<style>${css}</style>` +
      `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;` +
      (scrollY ? `addEventListener("load",function(){scrollTo(0,${scrollY})});` : "") +
      `})()</script>`;
    fs.writeFileSync(path.join(OUT, "frames", `${f.file}.html`), "<!DOCTYPE html>" + r.html.replace("<head>", "<head>" + head));
    await page.screenshot({ path: path.join(OUT, "frames", `${f.file}.png`), fullPage: !!f.full });
  }
});
