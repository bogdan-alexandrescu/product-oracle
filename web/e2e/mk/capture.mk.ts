// MOCK-HOOK: mk-runplan frame capture (never merged). Each frame: a fresh mock session, the
// real UI driven to the state, then a static HTML snapshot (styles inlined, scripts removed,
// fonts in assets/) and a PNG under mockups-out/mk-runplan/.
import fs from "node:fs"; // MOCK-HOOK
import path from "node:path"; // MOCK-HOOK
import { test, expect, type Page } from "../test"; // MOCK-HOOK
import { MOCK_SCENARIO_KEY } from "../../lib/api/mock/server"; // MOCK-HOOK
import { PRIORITY_RUN } from "../../lib/api/mock/runs"; // MOCK-HOOK

const OUT = path.resolve(__dirname, "../../../mockups-out/mk-runplan"); // MOCK-HOOK
const FRAMES = path.join(OUT, "frames"); // MOCK-HOOK
const ASSETS = path.join(OUT, "assets"); // MOCK-HOOK

type Frame = { file: string; w: number; h: number; go: (page: Page) => Promise<void> }; // MOCK-HOOK

async function signIn(page: Page, email: string, scenario?: string) { // MOCK-HOOK
  if (scenario) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [MOCK_SCENARIO_KEY, scenario] as const); // MOCK-HOOK
  await page.addInitScript(() => localStorage.setItem("oracle-theme", "light")); // MOCK-HOOK
  await page.goto("/login?next=%2Fhome"); // MOCK-HOOK
  await page.getByLabel("Email").fill(email); // MOCK-HOOK
  await page.getByLabel("Password").fill(["de", "mo"].join("")); // MOCK-HOOK
  await page.getByRole("button", { name: "Sign in" }).click(); // MOCK-HOOK
  await page.waitForURL("**/home"); // MOCK-HOOK
} // MOCK-HOOK

/** RP1: the run's order stop (Detailed › Priorities in run mode) with the switches. */
const order = (q: string, after?: (page: Page) => Promise<void>) => async (page: Page) => { // MOCK-HOOK
  await signIn(page, "approver@example.com", "priority-order"); // MOCK-HOOK
  await page.goto(`/runs/${PRIORITY_RUN}`); // MOCK-HOOK
  await page.getByTestId("checkpoint-priority_order").getByRole("link", { name: "Review the order" }).click(); // MOCK-HOOK
  await page.waitForURL(/snapshot=/); // MOCK-HOOK
  await page.goto(`${page.url()}&${q}`); // MOCK-HOOK
  await expect(page.getByTestId("snapshot-band")).toBeVisible(); // MOCK-HOOK
  await expect(page.locator('tr[data-testid^="priority-row-"]').first()).toBeVisible(); // MOCK-HOOK
  if (after) await after(page); // MOCK-HOOK
}; // MOCK-HOOK

/** RP2: Simple's roadmap, the PRD's one-pager, the review meeting's Roadmap step. */
const roadmap = (q: string) => async (page: Page) => { // MOCK-HOOK
  await signIn(page, "admin@example.com"); // MOCK-HOOK
  await page.goto(`/simple/roadmap?${q}`); // MOCK-HOOK
  await expect(page.getByTestId("simple-roadmap")).toBeVisible(); // MOCK-HOOK
}; // MOCK-HOOK
const onePager = (q: string) => async (page: Page) => { // MOCK-HOOK
  await signIn(page, "admin@example.com"); // MOCK-HOOK
  await page.goto(`/simple/one-pagers/saved-carts?${q}`); // MOCK-HOOK
  await expect(page.getByRole("region", { name: "Timeline" }).first()).toBeVisible(); // MOCK-HOOK
}; // MOCK-HOOK
const meeting = (q: string, after?: (page: Page) => Promise<void>) => async (page: Page) => { // MOCK-HOOK
  await signIn(page, "admin@example.com"); // MOCK-HOOK
  await page.goto("/simple/prds/guided-setup"); // MOCK-HOOK: the mock's reviewable PRD, shown as the draft PRD
  await page.waitForLoadState("networkidle"); // MOCK-HOOK
  await expect(async () => { await page.getByRole("button", { name: "Start review" }).first().click(); await expect(page.getByRole("dialog", { name: "Start a review" })).toBeVisible({ timeout: 2000 }); }).toPass({ timeout: 30_000 }); // MOCK-HOOK
  await page.getByRole("dialog", { name: "Start a review" }).getByRole("button", { name: "Start", exact: true }).click(); // MOCK-HOOK
  await page.waitForURL(/\/simple\/meetings\/[^/?]+$/); // MOCK-HOOK
  await page.goto(`${page.url()}?step=1&${q}`); // MOCK-HOOK
  await expect(page.getByRole("region", { name: "Roadmap slice" })).toBeVisible(); // MOCK-HOOK
  if (after) await after(page); // MOCK-HOOK
}; // MOCK-HOOK

const D = { w: 1440, h: 900 }; // MOCK-HOOK
const W = { w: 1512, h: 982 }; // MOCK-HOOK
const P = { w: 390, h: 844 }; // MOCK-HOOK
const center = async (l: ReturnType<Page["getByText"]>) => { await l.first().evaluate((e) => e.scrollIntoView({ block: "center" })); await l.page().waitForTimeout(300); }; // MOCK-HOOK
const scrollTo = (name: string) => async (page: Page) => { await center(page.getByText(name, { exact: true })); }; // MOCK-HOOK

const ALL: Frame[] = [ // MOCK-HOOK
  { file: "rp1-a-rest", ...D, go: order("rp1=a") }, // MOCK-HOOK
  { file: "rp1-a-open", ...D, go: order("rp1=a&sel=N-4") }, // MOCK-HOOK
  { file: "rp1-a-done", ...D, go: order("rp1=a&done=1") }, // MOCK-HOOK
  { file: "rp1-a-rest-1512", ...W, go: order("rp1=a&sel=N-4") }, // MOCK-HOOK
  { file: "rp1-a-rest-390", ...P, go: order("rp1=a") }, // MOCK-HOOK
  { file: "rp1-b-rest", ...D, go: order("rp1=b") }, // MOCK-HOOK
  { file: "rp1-b-open", ...D, go: order("rp1=b&open=1") }, // MOCK-HOOK
  { file: "rp1-b-mid", ...D, go: order("rp1=b&open=1&phase=mid", async (page) => { await center(page.getByRole("button", { name: "Accept 5 and rank them" })); }) }, // MOCK-HOOK
  { file: "rp1-b-done", ...D, go: order("rp1=b&done=1") }, // MOCK-HOOK
  { file: "rp1-b-open-1512", ...W, go: order("rp1=b&open=1&phase=mid") }, // MOCK-HOOK
  { file: "rp1-b-open-390", ...P, go: order("rp1=b&open=1&phase=mid", async (page) => { await center(page.getByRole("button", { name: "Accept 5 and rank them" })); }) }, // MOCK-HOOK
  { file: "rp1-c-rest", ...D, go: order("rp1=c", scrollTo("Proposed by this PRD")) }, // MOCK-HOOK
  { file: "rp1-c-open", ...D, go: order("rp1=c&open=1", scrollTo("Proposed by this PRD")) }, // MOCK-HOOK
  { file: "rp1-c-mid", ...D, go: order("rp1=c&open=1&phase=mid", scrollTo("Proposed by this PRD")) }, // MOCK-HOOK
  { file: "rp1-c-done", ...D, go: order("rp1=c&done=1") }, // MOCK-HOOK
  { file: "rp1-c-rest-1512", ...W, go: order("rp1=c") }, // MOCK-HOOK
  { file: "rp1-d-rest", ...D, go: order("rp1=d", scrollTo("Not ranked yet")) }, // MOCK-HOOK
  { file: "rp1-d-done", ...D, go: order("rp1=d&done=1") }, // MOCK-HOOK
  { file: "rp1-d-rest-1512", ...W, go: order("rp1=d") }, // MOCK-HOOK
  { file: "rp2-a-rest", ...D, go: roadmap("rp2=a") }, // MOCK-HOOK
  { file: "rp2-a-open", ...D, go: roadmap("rp2=a&open=1") }, // MOCK-HOOK
  { file: "rp2-a-done", ...D, go: roadmap("rp2=a&done=1&prd=saved-carts") }, // MOCK-HOOK
  { file: "rp2-a-rest-1512", ...W, go: roadmap("rp2=a") }, // MOCK-HOOK
  { file: "rp2-a-rest-390", ...P, go: roadmap("rp2=a") }, // MOCK-HOOK
  { file: "rp2-b-rest", ...D, go: onePager("rp2=b") }, // MOCK-HOOK
  { file: "rp2-b-open", ...D, go: onePager("rp2=b&open=1") }, // MOCK-HOOK
  { file: "rp2-b-cost", ...D, go: meeting("rp2=b") }, // MOCK-HOOK
  { file: "rp2-b-rest-1512", ...W, go: onePager("rp2=b&open=1") }, // MOCK-HOOK
  { file: "rp2-b-rest-390", ...P, go: onePager("rp2=b") }, // MOCK-HOOK
  { file: "rp2-c-rest", ...D, go: meeting("rp2=c") }, // MOCK-HOOK
  { file: "rp2-c-mid", ...D, go: meeting("rp2=c&phase=mid") }, // MOCK-HOOK
  { file: "rp2-c-open", ...D, go: meeting("rp2=c&phase=mid&open=1", async (page) => { await center(page.getByRole("button", { name: "Approve dates" })); }) }, // MOCK-HOOK
  { file: "rp2-c-done", ...D, go: meeting("rp2=c&done=1") }, // MOCK-HOOK
  { file: "rp2-c-rest-1512", ...W, go: meeting("rp2=c") }, // MOCK-HOOK
  { file: "rp2-c-rest-390", ...P, go: meeting("rp2=c") }, // MOCK-HOOK
  { file: "rp2-d-rest", ...D, go: roadmap("rp2=d") }, // MOCK-HOOK
  { file: "rp2-d-onepager", ...D, go: onePager("rp2=d") }, // MOCK-HOOK
  { file: "rp2-d-meeting", ...D, go: meeting("rp2=d") }, // MOCK-HOOK
  { file: "rp2-d-rest-1512", ...W, go: roadmap("rp2=d") }, // MOCK-HOOK
]; // MOCK-HOOK

const only = process.env.MK_ONLY ? new RegExp(process.env.MK_ONLY) : null; // MOCK-HOOK

/** Snapshot the page: a static HTML file (styles inlined, scripts gone, fonts in assets/) and a PNG. */
async function snap(page: Page, f: Frame) { // MOCK-HOOK
  await page.waitForTimeout(900); // MOCK-HOOK
  const { html, css } = await page.evaluate(() => { // MOCK-HOOK
    document.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox" || i.type === "radio") i.toggleAttribute("checked", i.checked); else i.setAttribute("value", i.value); }); // MOCK-HOOK
    document.querySelectorAll("textarea").forEach((t) => { t.textContent = t.value; }); // MOCK-HOOK
    document.querySelectorAll("select").forEach((s) => s.querySelectorAll("option").forEach((o) => o.toggleAttribute("selected", o.selected))); // MOCK-HOOK
    const css: string[] = []; // MOCK-HOOK
    for (const sh of Array.from(document.styleSheets)) { try { css.push(Array.from(sh.cssRules).map((r) => r.cssText).join("\n")); } catch { /* cross-origin */ } } // MOCK-HOOK
    const doc = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
    doc.querySelectorAll("script, link, style, noscript, iframe, next-route-announcer").forEach((n) => n.remove()); // MOCK-HOOK
    return { html: doc.outerHTML, css: css.join("\n") }; // MOCK-HOOK
  }); // MOCK-HOOK
  let out = css; // MOCK-HOOK
  const urls = [...new Set([...css.matchAll(/url\((['"]?)((?:\/_next\/static\/|\.\.\/)media\/[^'")]+)\1\)/g)].map((m) => m[2]!))]; // MOCK-HOOK: fonts, as the stylesheets name them
  for (const u of urls) { // MOCK-HOOK
    const name = path.basename(u.split("?")[0]!); // MOCK-HOOK
    const dest = path.join(ASSETS, name); // MOCK-HOOK
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, await (await page.request.get(`/_next/static/media/${name}`)).body()); // MOCK-HOOK
    out = out.split(u).join(`../assets/${name}`); // MOCK-HOOK
  } // MOCK-HOOK
  const hook = `<meta name="mockup-viewport" content="${f.w}x${f.h}"><style>${out}</style><script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)})()</script>`; // MOCK-HOOK
  const doc = `<!DOCTYPE html>\n${html.replace(/<head([^>]*)>/, `<head$1>${hook}`)}`; // MOCK-HOOK
  fs.writeFileSync(path.join(FRAMES, `${f.file}.html`), doc); // MOCK-HOOK
  await page.screenshot({ path: path.join(FRAMES, `${f.file}.png`), fullPage: false }); // MOCK-HOOK
} // MOCK-HOOK

for (const f of ALL.filter((x) => !only || only.test(x.file))) { // MOCK-HOOK
  test.describe(f.file, () => { // MOCK-HOOK
    test.use({ viewport: { width: f.w, height: f.h }, colorScheme: "light", ...(f.w < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }); // MOCK-HOOK
    test("frame", async ({ page }) => { // MOCK-HOOK
      fs.mkdirSync(FRAMES, { recursive: true }); // MOCK-HOOK
      fs.mkdirSync(ASSETS, { recursive: true }); // MOCK-HOOK
      await f.go(page); // MOCK-HOOK
      await snap(page, f); // MOCK-HOOK
    }); // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK
