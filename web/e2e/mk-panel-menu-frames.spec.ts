// MOCK-HOOK (whole file): mk-panel-menu mock-ups only, never merged. Drives the mock app through
// its UI to each frame of the feature panel menu set and saves the frame (static HTML with its CSS
// inlined, fonts beside it in ../media, plus a PNG). MK_FRAMES=1 writes the frames; without it the
// spec only walks the frames and checks what each must show.
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { GOAL_BUCKETS_HARD_SCENARIO, MOCK_SCENARIO_KEY } from "../lib/api/mock/server";

const OUT = path.join(__dirname, "../../mockups-out/mk-panel-menu/frames");
const MEDIA = path.join(OUT, "../media");
const DARK = process.env.MK_DARK_DIR;
const HOOK =
  "<script>(function(){var t=new URLSearchParams(location.search).get('theme');if(t)document.documentElement.setAttribute('data-theme',t);document.querySelectorAll('[data-mk-scroll]').forEach(function(e){var p=e.getAttribute('data-mk-scroll').split(',');e.scrollTop=+p[0];e.scrollLeft=+p[1];});})();</script>";

const D = { width: 1440, height: 900 };
const W = { width: 1512, height: 945 };
const P = { width: 390, height: 844 };
const F1 = "Alert history export";
const F2 = "Alert rules engine";
const CUT = "In-app tour";

async function login(page: Page, role: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  if (role !== "owner") await page.evaluate((r) => localStorage.setItem("po-mock-role", r), role);
}
async function go(page: Page, p: string) {
  await page.goto(p);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700);
}
async function panel(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible();
  await page.waitForTimeout(600);
}
const dlg = (page: Page) => page.getByTestId("mk-confirm");
async function inDialog(page: Page, name: string) {
  await dlg(page).getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(600);
}
async function toStatus(page: Page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => /^(Cut|Restore|Propose a cut|Propose a restore)$/.test(e.innerText.trim()) && e.className.includes("underline"));
    b?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(300);
}
async function roadmap(page: Page, q: string, role = "owner", feat = F1) {
  await login(page, role);
  await go(page, `/simple/roadmap?${q}`);
  await panel(page, feat);
}
async function trashPage(page: Page, v: string, role = "owner", extra = "") {
  await roadmap(page, "pm1=a&pm2=b&open=delete", "owner", F2);
  await inDialog(page, "Move to Trash");
  if (role !== "owner") await page.evaluate((r) => localStorage.setItem("po-mock-role", r), role);
  await go(page, `/settings/trash?pm3=${v}${extra}`);
  if (!extra.includes("Goal")) await expect(page.getByText(F2, { exact: true })).toBeVisible();
}
/** pm2 d: Move to Trash acts at once, so the panel closes as it opens. */
async function trashAtOnce(page: Page, role: string) {
  await login(page, role);
  await go(page, "/simple/roadmap?pm1=a&pm2=d&open=delete");
  await page.getByText(F2, { exact: true }).first().click();
  await expect(page.getByText(role === "owner" ? `Moved ${F2} to Trash` : "waiting for Avery Stone")).toBeVisible();
}
const openTip = (page: Page) => page.getByRole("button", { name: `About What Restore puts back for ${F2}` }).click();
async function restore(page: Page) {
  await page.getByRole("button", { name: `Restore ${F2}` }).click();
  await page.waitForTimeout(500);
}
async function bottom(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((e) => {
      if (e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== "visible") e.scrollTop = e.scrollHeight;
    });
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(300);
}

async function snap(page: Page, name: string, vp: { width: number; height: number }) {
  if (page.url().includes("/simple/")) await page.locator('[id^="simple-nav-decisions-count"], [id^="simple-tab-decisions-count"]').first().waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  if (!process.env.MK_FRAMES) return;
  let html = await page.evaluate(() => {
    const css: string[] = [];
    for (const sh of [...document.styleSheets]) {
      try {
        const base = sh.href || location.href;
        css.push([...sh.cssRules].map((r) => r.cssText.replace(/url\(\s*"?([^")]+)"?\s*\)/g, (m, u: string) => (u.startsWith("data:") ? m : `url("${new URL(u, base).href}")`))).join("\n"));
      } catch {}
    }
    const marks: Element[] = [];
    document.querySelectorAll("*").forEach((e) => {
      if (e.scrollTop || e.scrollLeft) {
        e.setAttribute("data-mk-scroll", `${Math.round(e.scrollTop)},${Math.round(e.scrollLeft)}`);
        marks.push(e);
      }
    });
    document.querySelectorAll("input,textarea").forEach((i) => i.setAttribute("value", (i as HTMLInputElement).value));
    const c = document.documentElement.cloneNode(true) as HTMLElement;
    marks.forEach((e) => e.removeAttribute("data-mk-scroll"));
    c.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[as], style, next-route-announcer, nextjs-portal").forEach((n) => n.remove());
    c.removeAttribute("data-theme");
    const st = document.createElement("style");
    st.textContent = css.join("\n");
    c.querySelector("head")!.appendChild(st);
    return "<!DOCTYPE html>" + c.outerHTML;
  });
  const fonts = [...html.matchAll(/url\("(http[^"]+\.woff2)"\)/g)].map((m) => m[1]);
  fs.mkdirSync(MEDIA, { recursive: true });
  for (const u of new Set(fonts)) {
    const file = path.join(MEDIA, u.split("/").pop()!);
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await page.request.get(u)).body()));
    html = html.split(`url("${u}")`).join(`url("../media/${u.split("/").pop()}")`);
  }
  html = html.replace("<head>", `<head><meta name="mockup-viewport" content="${vp.width}x${vp.height}">`).replace("</body>", `${HOOK}</body>`);
  fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  if (DARK) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(DARK, `${name}--dark.png`) });
  }
}

type Frame = [string, { width: number; height: number }, (page: Page) => Promise<unknown>];
const F: Frame[] = [];
for (const v of "abcd") {
  const menu = v !== "d" ? "&open=menu" : "";
  const st = async (page: Page) => v === "d" && (await toStatus(page));
  F.push([`pm1-${v}-rest`, D, async (p) => (await roadmap(p, `pm1=${v}`), await st(p))]);
  if (v !== "d") F.push([`pm1-${v}-open`, D, (p) => roadmap(p, `pm1=${v}&open=menu`)]);
  F.push([`pm1-${v}-mid`, D, (p) => roadmap(p, `pm1=${v}&open=cut`)]);
  F.push([`pm1-${v}-result`, D, async (p) => (await roadmap(p, `pm1=${v}&open=cut`), await inDialog(p, "Cut from the roadmap"), await st(p))]);
  F.push([`pm1-${v}-cut-1512`, W, async (p) => (await roadmap(p, `pm1=${v}${menu}`, "owner", CUT), await st(p))]);
  F.push([`pm1-${v}-propose`, D, async (p) => (await roadmap(p, `pm1=${v}${menu}`, "approver"), await st(p), await expect(p.getByText("Avery Stone decides").first()).toBeVisible())]);
  F.push([`pm1-${v}-viewer`, D, async (p) => (await roadmap(p, `pm1=${v}`, "viewer", CUT), await st(p))]);
  F.push([`pm1-${v}-cut-390`, P, async (p) => (await roadmap(p, `pm1=${v}`, "owner", CUT), await st(p))]);
  if (v !== "d") F.push([`pm1-${v}-open-390`, P, (p) => roadmap(p, `pm1=${v}&open=menu`, "owner", CUT)]);
}
for (const v of "abc") {
  F.push([`pm2-${v}-confirm`, D, (p) => roadmap(p, `pm1=a&pm2=${v}&open=delete`, "owner", F2)]);
  F.push([
    `pm2-${v}-result`,
    D,
    async (p) => {
      await roadmap(p, `pm1=a&pm2=${v}&open=delete`, "owner", F2);
      if (v === "c") await dlg(p).getByLabel("Its name").fill(F2);
      await inDialog(p, "Move to Trash");
      await expect(p.getByText(`Moved ${F2} to Trash`)).toBeVisible();
    },
  ]);
  F.push([
    `pm2-${v}-goal-1512`,
    W,
    async (p) => {
      await p.context().addInitScript(([k, val]) => localStorage.setItem(k, val), [MOCK_SCENARIO_KEY, GOAL_BUCKETS_HARD_SCENARIO] as const);
      await login(p, "owner");
      await go(p, `/simple/priorities?tab=buckets&pm2=${v}`);
      await p.getByRole("button", { name: "More for Grow partner network" }).click();
      await p.getByRole("menuitem", { name: "Move to Trash…" }).click();
      await expect(dlg(p)).toContainText("and 11 more");
    },
  ]);
  F.push([`pm2-${v}-propose`, D, async (p) => (await roadmap(p, `pm1=a&pm2=${v}&open=delete`, "approver", F2), await expect(dlg(p).getByText("Avery Stone decides")).toBeVisible())]);
  F.push([`pm2-${v}-confirm-390`, P, (p) => roadmap(p, `pm1=a&pm2=${v}&open=delete`, "owner", F2)]);
}
F.push([`pm2-a-mid`, D, async (p) => (await roadmap(p, "pm1=a&pm2=a&open=delete", "owner", F2), await dlg(p).getByRole("button", { name: "About What goes with it" }).click())]);
F.push([
  `pm2-c-mid`,
  D,
  async (p) => {
    await roadmap(p, "pm1=a&pm2=c&open=delete", "owner", F2);
    await dlg(p).getByLabel("Its name").pressSequentially("Alert ru", { delay: 30 });
    await expect(dlg(p).getByRole("button", { name: "Move to Trash", exact: true })).toBeDisabled();
  },
]);
F.push([`pm2-d-result`, D, (p) => trashAtOnce(p, "owner")]);
F.push([`pm2-d-propose`, D, (p) => trashAtOnce(p, "approver")]);
F.push([`pm2-d-result-390`, P, (p) => trashAtOnce(p, "owner")]);
for (const v of "abc") {
  F.push([`pm3-${v}-rest`, D, (p) => trashPage(p, v)]);
  F.push([`pm3-${v}-open`, D, async (p) => (await trashPage(p, v), await openTip(p))]);
  F.push([`pm3-${v}-result`, D, async (p) => (await trashPage(p, v), await restore(p))]);
  F.push([`pm3-${v}-hard-1512`, W, async (p) => (await trashPage(p, v, "owner", v === "c" ? "&tab=Feature" : ""), await bottom(p))]);
  F.push([`pm3-${v}-propose`, D, (p) => trashPage(p, v, "approver")]);
  F.push([`pm3-${v}-viewer`, D, (p) => trashPage(p, v, "viewer")]);
  F.push([`pm3-${v}-rest-390`, P, (p) => trashPage(p, v)]);
}
F.push([`pm3-c-goals`, D, (p) => trashPage(p, "c", "owner", "&tab=Goal")]);
F.push([`pm3-a-back`, D, async (p) => (await trashPage(p, "a"), await restore(p), await go(p, "/simple/roadmap?pm1=a"), await panel(p, F2))]);

const only = process.env.MK_ONLY?.split(",");
for (const [name, vp, fn] of process.env.MK_HTML_URL ? [] : F) {
  if (only && !only.some((o) => name.startsWith(o))) continue;
  test(`mk-panel-menu frame ${name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(vp);
    await fn(page);
    await snap(page, name, vp);
  });
}

// MK_HTML_URL (a static server over mockups-out/mk-panel-menu): opens each saved HTML frame as the
// owner will, light and dark, and saves what it shows to MK_HTML_OUT.
if (process.env.MK_HTML_URL) {
  for (const file of fs.readdirSync(OUT).filter((f) => f.endsWith(".html"))) {
    const name = file.replace(/\.html$/, "");
    if (only && !only.some((o) => name.startsWith(o))) continue;
    test(`mk-panel-menu html ${name}`, async ({ page }) => {
      const [w, h] = /mockup-viewport" content="(\d+)x(\d+)"/.exec(fs.readFileSync(path.join(OUT, file), "utf8"))!.slice(1).map(Number);
      await page.setViewportSize({ width: w, height: h });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
        await page.goto(`${process.env.MK_HTML_URL}/frames/${file}?theme=${theme}`);
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(process.env.MK_HTML_OUT!, `${name}--${theme}.png`) });
      }
    });
  }
}
