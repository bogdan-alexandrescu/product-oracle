// MOCK-HOOK: the whole file captures the mk-fitdate mock-up frames (static html + png) under
// mockups-out/mk-fitdate. Run against the mock build: E2E_PORT=3393 npx playwright test mk-fitdate-frames.
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./test";
import { ADMIN } from "./helpers";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-fitdate");
const DESK = { width: 1440, height: 900 };
const WIDE = { width: 1512, height: 982 };
const PHONE = { width: 390, height: 844 };

type Frame = { file: string; url: string; size: { width: number; height: number }; theme?: "light" | "dark"; act?: (page: Page) => Promise<void> };

const home = (q: string) => `/simple?${q}`;
const road = (q: string) => `/simple/roadmap?${q}`;
const tick = (name: RegExp) => async (page: Page) => {
  await page.getByTestId("fit-panel").getByRole("checkbox", { name }).click();
};

const FRAMES: Frame[] = [
  // FD1: where the owner asks.
  { file: "fd1-a-rest", url: road("fd1=a"), size: DESK },
  { file: "fd1-a-open", url: road("fd1=a"), size: DESK, act: async (p) => p.getByTestId("fit-ask").click() },
  { file: "fd1-a-hard-1512", url: road("fd1=a&phase=hard"), size: WIDE },
  { file: "fd1-a-phone", url: road("fd1=a"), size: PHONE },
  { file: "fd1-a-dark", url: road("fd1=a"), size: DESK, theme: "dark" },
  { file: "fd1-b-rest", url: home("fd1=b"), size: DESK },
  { file: "fd1-b-open", url: home("fd1=b"), size: DESK, act: async (p) => p.getByRole("button", { name: "See what to cut" }).click() },
  { file: "fd1-b-hard-1512", url: home("fd1=b&phase=hard"), size: WIDE },
  { file: "fd1-b-phone", url: home("fd1=b"), size: PHONE },
  { file: "fd1-b-dark", url: home("fd1=b"), size: DESK, theme: "dark" },
  { file: "fd1-c-rest", url: home("fd1=c"), size: DESK },
  { file: "fd1-c-open", url: home("fd1=c"), size: DESK, act: async (p) => p.getByRole("button", { name: "Pick the changes" }).click() },
  { file: "fd1-c-hard-1512", url: home("fd1=c&phase=hard"), size: WIDE },
  { file: "fd1-c-after", url: home("fd1=c&phase=adjusted"), size: DESK },
  { file: "fd1-c-phone", url: home("fd1=c"), size: PHONE },
  { file: "fd1-c-dark", url: home("fd1=c"), size: DESK, theme: "dark" },
  // FD2: how Oracle shows its picks (asked from Roadmap, FD1 a).
  { file: "fd2-a-open", url: road("fd2=a&phase=open"), size: DESK },
  { file: "fd2-a-mid", url: road("fd2=a&phase=mid"), size: DESK },
  { file: "fd2-a-picked", url: road("fd2=a&phase=mid"), size: DESK, act: async (p) => { await tick(/Reply time chart/)(p); await tick(/Tone presets/)(p); } },
  { file: "fd2-a-hard-1512", url: road("fd2=a&phase=hard"), size: WIDE },
  { file: "fd2-a-phone", url: road("fd2=a&phase=mid"), size: PHONE },
  { file: "fd2-a-dark", url: road("fd2=a&phase=mid"), size: DESK, theme: "dark" },
  { file: "fd2-b-open", url: road("fd2=b&phase=open"), size: DESK },
  { file: "fd2-b-mid", url: road("fd2=b&phase=mid"), size: DESK },
  { file: "fd2-b-picked", url: road("fd2=b&phase=mid"), size: DESK, act: async (p) => p.getByTestId("fit-panel").getByRole("radio").nth(1).check() },
  { file: "fd2-b-hard-1512", url: road("fd2=b&phase=hard"), size: WIDE },
  { file: "fd2-b-phone", url: road("fd2=b&phase=open"), size: PHONE },
  { file: "fd2-b-dark", url: road("fd2=b&phase=open"), size: DESK, theme: "dark" },
  { file: "fd2-c-open", url: road("fd2=c&phase=open"), size: DESK },
  { file: "fd2-c-mid", url: road("fd2=c&phase=mid"), size: DESK },
  { file: "fd2-c-hard-1512", url: road("fd2=c&phase=hard"), size: WIDE },
  { file: "fd2-c-phone", url: road("fd2=c&phase=open"), size: PHONE },
  { file: "fd2-c-dark", url: road("fd2=c&phase=mid"), size: DESK, theme: "dark" },
  // FD3: what happens after the pick.
  { file: "fd3-a-open", url: road("fd3=a&phase=open"), size: DESK },
  { file: "fd3-a-result", url: road("fd3=a&phase=result"), size: DESK },
  { file: "fd3-a-adjusted", url: road("fd3=a&phase=adjusted"), size: DESK },
  { file: "fd3-a-home", url: home("fd1=b&fd3=a&phase=adjusted"), size: DESK },
  { file: "fd3-a-hard-1512", url: road("fd3=a&phase=hard"), size: WIDE },
  { file: "fd3-a-phone", url: road("fd3=a&phase=result"), size: PHONE },
  { file: "fd3-a-dark", url: road("fd3=a&phase=adjusted"), size: DESK, theme: "dark" },
  { file: "fd3-b-open", url: road("fd3=b&phase=open"), size: DESK },
  { file: "fd3-b-result", url: road("fd3=b&phase=result"), size: DESK },
  { file: "fd3-b-adjusted", url: road("fd3=b&phase=adjusted"), size: DESK },
  { file: "fd3-b-home", url: home("fd1=b&fd3=b&phase=adjusted"), size: DESK },
  { file: "fd3-b-hard-1512", url: road("fd3=b&phase=hard"), size: WIDE },
  { file: "fd3-b-phone", url: road("fd3=b&phase=result"), size: PHONE },
  { file: "fd3-b-dark", url: road("fd3=b&phase=result"), size: DESK, theme: "dark" },
  { file: "fd3-c-open", url: road("fd3=c&phase=open"), size: DESK },
  { file: "fd3-c-result", url: road("fd3=c&phase=result"), size: DESK },
  { file: "fd3-c-adjusted", url: road("fd3=c&phase=adjusted"), size: DESK },
  { file: "fd3-c-home", url: home("fd1=b&fd3=c&phase=adjusted"), size: DESK },
  { file: "fd3-c-hard-1512", url: road("fd3=c&phase=hard"), size: WIDE },
  { file: "fd3-c-phone", url: road("fd3=c&phase=result"), size: PHONE },
  { file: "fd3-c-dark", url: road("fd3=c&phase=result"), size: DESK, theme: "dark" },
];

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
test.setTimeout(20 * 60_000);

async function snapshot(page: Page, f: Frame) {
  const { html, fonts } = await page.evaluate(
    ({ w, h }) => {
      const fonts = new Set<string>();
      let css = "";
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const r of Array.from(sheet.cssRules)) css += r.cssText + "\n";
        } catch {
          /* a cross-origin sheet: none here */
        }
      }
      css = css.replace(/url\(["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\)/g, (_m, u: string) => {
        const abs = new URL(u, location.href).pathname;
        fonts.add(abs);
        return `url("../assets/${abs.split("/").pop()}")`;
      });
      document.querySelectorAll("input").forEach((i) => {
        if (i.checked) i.setAttribute("checked", "");
        else i.removeAttribute("checked");
      });
      const doc = document.documentElement.cloneNode(true) as HTMLElement;
      doc.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, noscript, next-route-announcer").forEach((n) => n.remove());
      const head = doc.querySelector("head")!;
      const meta = document.createElement("meta");
      meta.name = "mockup-viewport";
      meta.content = `${w}x${h}`;
      head.prepend(meta);
      const style = document.createElement("style");
      style.textContent = css;
      head.append(style);
      const hook = document.createElement("script");
      hook.textContent = "var t=new URLSearchParams(location.search).get('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;";
      head.prepend(hook);
      return { html: "<!doctype html>\n" + doc.outerHTML, fonts: [...fonts] };
    },
    { w: f.size.width, h: f.size.height },
  );
  for (const u of fonts) {
    const dest = path.join(OUT, "assets", u.split("/").pop()!);
    if (fs.existsSync(dest)) continue;
    const res = await page.request.get(u);
    fs.writeFileSync(dest, await res.body());
  }
  fs.writeFileSync(path.join(OUT, "frames", `${f.file}.html`), html);
  await page.screenshot({ path: path.join(OUT, "frames", `${f.file}.png`) });
}

test("mk-fitdate frames", async ({ page }) => {
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
  const only = process.env.FRAMES?.split(",");
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  for (const f of FRAMES) {
    if (only && !only.some((o) => f.file.startsWith(o))) continue;
    const theme = f.theme ?? "light";
    await page.setViewportSize(f.size);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${f.url}&theme=${theme}`);
    await expect(page.locator("[data-testid=fit-roadmap], [data-testid=fit-home], [data-testid=fit-ask-chat]").first()).toBeVisible();
    if (f.act) await f.act(page);
    await page.waitForTimeout(600);
    await snapshot(page, f);
  }
});
