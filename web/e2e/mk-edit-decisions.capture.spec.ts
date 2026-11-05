// MOCK-HOOK: this whole file captures the mk-edit-decisions mock-up frames (never merged).
// MOCK-HOOK: MK_CAPTURE=1 E2E_PORT=3393 npx playwright test e2e/mk-edit-decisions.capture.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ADMIN } from "./helpers";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-edit-decisions");
const ONLY = process.env.MK_ONLY ?? "";

type Who = "owner" | "approver" | "viewer";
type Frame = { file: string; url: string; w?: number; h?: number; scroll?: string; block?: ScrollLogicalPosition; click?: string; fill?: [string, string]; who?: Who };
// Each frame signs in as its own invented person: Avery Stone (owner), Priya Raman (an approver who is not the decider), Lena Ortiz (viewer).
const PEOPLE: Record<Who, string> = { owner: ADMIN.email, approver: "approver@example.com", viewer: "viewer@example.com" };

const D = "/simple/decisions";
const CLOCK = "2026-11-05T17:00:00Z";
const ec1 = (v: string): Frame[] => [
  { file: `ec1-${v}-rest`, url: `${D}?ec1=${v}`, scroll: "#mk-outside" },
  { file: `ec1-${v}-open`, url: `${D}?ec1=${v}&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside" },
  { file: `ec1-${v}-mid`, url: `${D}?ec1=${v}&phase=mid`, scroll: "#mk-outside" },
  { file: `ec1-${v}-done`, url: `${D}?ec1=${v}&phase=done`, scroll: "#mk-outside" },
  // Reassign starts from the edited state (the done frame before it): its third option, review day and edited mark stay.
  { file: `ec1-${v}-reassign`, url: `${D}?ec1=${v}&phase=done&open=1&act=reassign`, scroll: "#mk-outside" },
  { file: `ec1-${v}-reassigned`, url: `${D}?ec1=${v}&phase=done&act=reassign`, scroll: "#mk-outside" },
  { file: `ec1-${v}-withdrawn`, url: `${D}?ec1=${v}&phase=done&act=withdraw`, scroll: "#mk-outside" },
  { file: `ec1-${v}-deleted`, url: `${D}?ec1=${v}&phase=done&act=delete`, scroll: "#mk-outside" },
  { file: `ec1-${v}-new`, url: `${D}?ec1=${v}&open=1&act=new&phase=mid`, scroll: v === "c" ? "#mk-outside" : v === "a" ? "section[aria-label='New decision']" : undefined },
  { file: `ec1-${v}-new-done`, url: `${D}?ec1=${v}&act=new&phase=done`, scroll: "#mk-outside" },
  { file: `ec1-${v}-hard`, url: `${D}?ec1=${v}&long=1&phase=mid`, scroll: "#mk-outside" },
  { file: `ec1-${v}-hard-1512`, url: `${D}?ec1=${v}&long=1&phase=mid`, w: 1512, h: 982, scroll: "#mk-outside" },
  // c's options sit low in the row: the phone frame centres the third option, so it reads whole above the tab bar.
  { file: `ec1-${v}-mid-390`, url: `${D}?ec1=${v}&phase=mid`, w: 390, h: 844, ...(v === "c" ? { scroll: "[aria-label='Option 3']", block: "center" as ScrollLogicalPosition } : { scroll: "#mk-outside" }) },
  { file: `ec1-${v}-propose`, url: `${D}?ec1=${v}&as=approver&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside", who: "approver" },
  { file: `ec1-${v}-read`, url: `${D}?ec1=${v}&as=viewer&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: "#mk-outside", who: "viewer" },
];
const eq2 = (v: string): Frame[] => [
  { file: `eq2-${v}-rest`, url: `${D}?eq2=${v}` },
  { file: `eq2-${v}-open`, url: `${D}?eq2=${v}&open=1&act=${v === "b" ? "sheet" : "edit"}` },
  { file: `eq2-${v}-mid`, url: `${D}?eq2=${v}&phase=mid` },
  { file: `eq2-${v}-done`, url: `${D}?eq2=${v}&phase=done` },
  { file: `eq2-${v}-withdrawn`, url: `${D}?eq2=${v}&phase=done&act=withdraw` },
  { file: `eq2-${v}-deleted`, url: `${D}?eq2=${v}&phase=done&act=delete` },
  { file: `eq2-${v}-new`, url: `${D}?eq2=${v}&open=1&act=new&phase=mid`, scroll: v === "b" ? undefined : "[data-testid=mk-ask-row]" },
  { file: `eq2-${v}-new-done`, url: `${D}?eq2=${v}&act=new&phase=done`, scroll: "[data-mk-added]", block: "center" },
  { file: `eq2-${v}-hard`, url: `${D}?eq2=${v}&long=1&phase=mid`, scroll: "[data-testid=questions-mine] [data-testid=question-row] >> nth=0" },
  { file: `eq2-${v}-hard-1512`, url: `${D}?eq2=${v}&long=1&phase=mid`, w: 1512, h: 982, scroll: "[data-testid=questions-mine] [data-testid=question-row] >> nth=0" },
  { file: `eq2-${v}-mid-390`, url: `${D}?eq2=${v}&phase=mid`, w: 390, h: 844 },
  { file: `eq2-${v}-propose`, url: `${D}?eq2=${v}&as=approver&open=1&act=${v === "b" ? "sheet" : "edit"}`, scroll: v === "c" ? "[data-testid=questions-mine]" : "[data-mk-target]", who: "approver" },
  ...(v === "c" ? [{ file: `eq2-c-propose-q5`, url: `${D}?eq2=c&as=approver&open=1&act=edit`, scroll: "[data-mk-target]", who: "approver" as Who }] : []),
  { file: `eq2-${v}-home`, url: `/simple?eq2=${v}`, scroll: "[data-code] >> nth=0" },
  { file: `eq2-${v}-read`, url: `${D}?eq2=${v}&as=viewer`, scroll: "[data-testid=questions-others]", who: "viewer" },
  ...(v === "b" ? [{ file: `eq2-b-read-sheet`, url: `${D}?eq2=b&as=viewer&open=1&act=sheet`, scroll: "[data-testid=questions-others]", who: "viewer" as Who }] : []),
];
const FRAMES = [...["a", "b", "c"].flatMap(ec1), ...["a", "b", "c"].flatMap(eq2)].filter((f) => !ONLY || new RegExp(ONLY).test(f.file));

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
      // A static file holds no focus: the focused element keeps its ring through a copy of the page's :focus rules on [data-mk-focus]
      // (theme tokens, so the dark theme reads as the page does).
      const focused = document.activeElement as HTMLElement | null;
      const focusCss: string[] = [];
      if (focused && focused !== document.body) {
        const visible = focused.matches(":focus-visible");
        const walk = (rules: CSSRuleList, wrap: (x: string) => string) => {
          for (const r of Array.from(rules)) {
            if (r instanceof CSSStyleRule && /:focus(?!-within)/.test(r.selectorText)) {
              const sel = r.selectorText.split(",").filter((x) => /:focus(?!-within)/.test(x) && (visible || !x.includes(":focus-visible")));
              if (sel.length) focusCss.push(wrap(`${sel.map((x) => x.replace(/:focus(-visible)?(?!-within)/g, "[data-mk-focus]")).join(",")}{${r.style.cssText}}`));
            } else if (r instanceof CSSMediaRule) walk(r.cssRules, (x) => wrap(`@media ${r.conditionText}{${x}}`));
            else if (r instanceof CSSLayerBlockRule || r instanceof CSSSupportsRule) walk(r.cssRules, wrap);
          }
        };
        for (const sh of Array.from(document.styleSheets)) {
          try { walk(sh.cssRules, (x) => x); } catch { /* another origin's sheet */ }
        }
        // The browser's own focus outline is not in the page's sheets: it goes inline.
        const cs = getComputedStyle(focused);
        // Its colour, when it is the accent, stays the token, so the dark theme draws its own.
        const probe = document.createElement("i");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const color = cs.outlineColor === accent ? "var(--accent)" : cs.outlineColor;
        const outline = cs.outlineStyle !== "none" ? `outline:${cs.outlineWidth} ${cs.outlineStyle} ${color};outline-offset:${cs.outlineOffset}` : "";
        focused.setAttribute("data-mk-focus", outline);
      }
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      focused?.removeAttribute("data-mk-focus");
      doc.querySelectorAll<HTMLElement>("[data-mk-focus]").forEach((n) => {
        const o = n.getAttribute("data-mk-focus");
        if (o) n.setAttribute("style", `${n.getAttribute("style") ?? ""};${o}`);
      });
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
      if (focusCss.length) {
        const st = document.createElement("style");
        st.textContent = focusCss.join("\n");
        head.append(st);
      }
      const meta = document.createElement("meta");
      meta.name = "mockup-viewport";
      meta.content = `${w}x${h}`;
      head.prepend(meta);
      if (!doc.getAttribute("data-theme")) doc.setAttribute("data-theme", "light");
      // Opens where the PNG was taken: an anchor at the scroll position (less the page's scroll padding), the fragment goes to it.
      if (window.scrollY > 0) {
        const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
        const at = document.createElement("div");
        at.id = "mk-at";
        at.setAttribute("aria-hidden", "true");
        at.setAttribute("style", `position:absolute;top:${window.scrollY + pad}px;left:0;width:1px;height:1px;pointer-events:none;scroll-margin:0`);
        doc.querySelector("body")!.append(at);
      }
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
  if (html.scrollY > 0) out = out.replace("<head>", `<head><meta http-equiv="refresh" content="0;url=#mk-at">`);
  fs.writeFileSync(path.join(OUT, "frames", `${f.file}.html`), out);
}

test("capture mk-edit-decisions frames", async ({ browser }) => {
  const pages = new Map<Who, Page>();
  const signedIn = async (who: Who) => {
    if (pages.has(who)) return pages.get(who)!;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // One fixed clock for every frame, so a decided row's time reads the same across proposals.
    await ctx.clock.setFixedTime(new Date(CLOCK));
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(PEOPLE[who]);
    await p.getByLabel("Password").fill(ADMIN.password);
    await p.getByRole("button", { name: "Sign in" }).click();
    await expect(p).not.toHaveURL(/\/login/);
    pages.set(who, p);
    return p;
  };
  for (const f of FRAMES) {
    const page = await signedIn(f.who ?? "owner");
    const w = f.w ?? 1440;
    const h = f.h ?? 900;
    await page.setViewportSize({ width: w, height: h });
    await page.goto(f.url);
    await expect(page.getByTestId(f.url.startsWith("/simple?") ? "home-greeting" : "simple-page")).toBeVisible();
    await page.waitForTimeout(f.url.startsWith("/simple?") ? 3000 : 1500);
    if (f.click) await page.locator(f.click).click();
    if (f.scroll) await page.locator(f.scroll).first().evaluate((el, block) => el.scrollIntoView({ block }), f.block ?? ((f.url.startsWith("/simple?") ? "center" : "start") as ScrollLogicalPosition));
    await page.waitForTimeout(300);
    await snapshot(page, f, w, h);
    await page.screenshot({ path: path.join(OUT, "frames", `${f.file}.png`) });
    // For looking only (never committed): the same frame in the dark theme.
    if (process.env.MK_DARK) {
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(process.env.MK_DARK, `${f.file}.png`) });
    }
  }
  for (const p of pages.values()) await p.context().close();
});
