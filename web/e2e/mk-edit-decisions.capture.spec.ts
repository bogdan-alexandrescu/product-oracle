// MOCK-HOOK: this whole file captures the mk-edit-decisions mock-up frames (never merged).
// MOCK-HOOK: MK_CAPTURE=1 E2E_PORT=3393 npx playwright test e2e/mk-edit-decisions.capture.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ADMIN } from "./helpers";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-edit-decisions");
const ONLY = process.env.MK_ONLY ?? "";

type Frame = { file: string; url: string; w?: number; h?: number; scroll?: string; click?: string; fill?: [string, string] };

const D = "/simple/decisions";
const ec1 = (v: string): Frame[] => [
  { file: `ec1-${v}-rest`, url: `${D}?ec1=${v}`, scroll: "#mk-outside" },
  { file: `ec1-${v}-open`, url: `${D}?ec1=${v}&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside" },
  { file: `ec1-${v}-mid`, url: `${D}?ec1=${v}&phase=mid`, scroll: "#mk-outside" },
  { file: `ec1-${v}-done`, url: `${D}?ec1=${v}&phase=done`, scroll: "#mk-outside" },
  { file: `ec1-${v}-reassign`, url: `${D}?ec1=${v}&open=1&act=reassign`, scroll: "#mk-outside" },
  { file: `ec1-${v}-withdrawn`, url: `${D}?ec1=${v}&phase=done&act=withdraw`, scroll: "#mk-outside" },
  { file: `ec1-${v}-new`, url: `${D}?ec1=${v}&open=1&act=new&phase=mid`, scroll: v === "c" ? "#mk-outside" : undefined },
  { file: `ec1-${v}-new-done`, url: `${D}?ec1=${v}&act=new&phase=done`, scroll: "#mk-outside" },
  { file: `ec1-${v}-hard-1512`, url: `${D}?ec1=${v}&long=1&phase=mid`, w: 1512, h: 982, scroll: "#mk-outside" },
  { file: `ec1-${v}-mid-390`, url: `${D}?ec1=${v}&phase=mid`, w: 390, h: 844, scroll: "#mk-outside" },
  { file: `ec1-${v}-propose`, url: `${D}?ec1=${v}&as=commenter&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside" },
  { file: `ec1-${v}-read`, url: `${D}?ec1=${v}&as=viewer&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside" },
];
const eq2 = (v: string): Frame[] => [
  { file: `eq2-${v}-rest`, url: `${D}?eq2=${v}` },
  { file: `eq2-${v}-open`, url: `${D}?eq2=${v}&open=1&act=${v === "b" ? "sheet" : "edit"}` },
  { file: `eq2-${v}-mid`, url: `${D}?eq2=${v}&phase=mid` },
  { file: `eq2-${v}-done`, url: `${D}?eq2=${v}&phase=done` },
  { file: `eq2-${v}-withdrawn`, url: `${D}?eq2=${v}&phase=done&act=withdraw` },
  { file: `eq2-${v}-new`, url: `${D}?eq2=${v}&open=1&act=new&phase=mid`, scroll: v === "b" ? undefined : "[data-testid=mk-ask-row]" },
  { file: `eq2-${v}-new-done`, url: `${D}?eq2=${v}&act=new&phase=done` },
  { file: `eq2-${v}-hard-1512`, url: `${D}?eq2=${v}&long=1&phase=mid`, w: 1512, h: 982, scroll: "[data-testid=questions-mine] [data-testid=question-row] >> nth=0" },
  { file: `eq2-${v}-mid-390`, url: `${D}?eq2=${v}&phase=mid`, w: 390, h: 844 },
  { file: `eq2-${v}-propose`, url: `${D}?eq2=${v}&as=commenter&open=1&act=${v === "b" ? "sheet" : "edit"}` },
  { file: `eq2-${v}-read`, url: `${D}?eq2=${v}&as=viewer`, scroll: "[data-testid=questions-others]" },
];
const FRAMES = [...["a", "b", "c"].flatMap(ec1), ...["a", "b", "c"].flatMap(eq2)].filter((f) => !ONLY || f.file.startsWith(ONLY));

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
test.skip(!process.env.MK_CAPTURE, "mock-up capture only");
test.setTimeout(30 * 60_000);

async function snapshot(page: Page, f: Frame, w: number, h: number) {
  const html = await page.evaluate(
    async ({ w, h }) => {
      document.querySelectorAll("input").forEach((i) => {
        if (i.type === "checkbox" || i.type === "radio") i.toggleAttribute("checked", i.checked);
        else i.setAttribute("value", i.value);
      });
      document.querySelectorAll("textarea").forEach((t) => (t.textContent = t.value));
      document.querySelectorAll("select").forEach((s) => Array.from(s.options).forEach((o) => o.toggleAttribute("selected", o.selected)));
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll("script, link[rel=preload], link[rel=modulepreload], next-route-announcer").forEach((n) => n.remove());
      const fonts: string[] = [];
      for (const l of Array.from(doc.querySelectorAll("link[rel=stylesheet]"))) {
        const href = (l as HTMLLinkElement).href;
        let css = await (await fetch(href)).text();
        css = css.replace(/url\((["']?)([^)"']+\.(?:woff2?|ttf))\1\)/g, (_m, _q, u: string) => {
          const name = u.split("/").pop()!;
          fonts.push(new URL(u, href).href);
          return `url(../assets/${name})`;
        });
        const st = document.createElement("style");
        st.textContent = css;
        l.replaceWith(st);
      }
      const head = doc.querySelector("head")!;
      const meta = document.createElement("meta");
      meta.name = "mockup-viewport";
      meta.content = `${w}x${h}`;
      head.prepend(meta);
      if (!doc.getAttribute("data-theme")) doc.setAttribute("data-theme", "light");
      return { html: "<!doctype html>\n" + doc.outerHTML, fonts, scrollY: window.scrollY };
    },
    { w, h },
  );
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
  for (const u of html.fonts) {
    const dest = path.join(OUT, "assets", u.split("/").pop()!);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, Buffer.from(await (await page.request.get(u)).body()));
  }
  // Opens where the frame was taken (a fragment, no script): the scrolled-to part on top.
  let out = html.html.replace("<head>", `<head><!-- ?theme=light|dark: set data-theme on <html> -->`);
  if (f.scroll && f.scroll.startsWith("#")) out = out.replace("<head>", `<head><meta http-equiv="refresh" content="0;url=#${f.scroll.slice(1)}">`);
  fs.writeFileSync(path.join(OUT, "frames", `${f.file}.html`), out);
}

test("capture mk-edit-decisions frames", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  for (const f of FRAMES) {
    const w = f.w ?? 1440;
    const h = f.h ?? 900;
    await page.setViewportSize({ width: w, height: h });
    await page.goto(f.url);
    await expect(page.getByTestId("simple-page")).toBeVisible();
    await page.waitForTimeout(1500);
    if (f.click) await page.locator(f.click).click();
    if (f.scroll) await page.locator(f.scroll).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(300);
    await snapshot(page, f, w, h);
    await page.screenshot({ path: path.join(OUT, "frames", `${f.file}.png`) });
  }
  await ctx.close();
});
