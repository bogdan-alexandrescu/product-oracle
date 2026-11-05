// MOCK-HOOK: mk-edit-goals-prds frame capture (throwaway branch, never merged). Drives the UI as a person would
// MOCK-HOOK: and saves each frame as a static HTML file (stylesheets inlined, scripts removed, fonts in assets/) and a PNG.
// MOCK-HOOK: Run: E2E_PORT=3393 swarm-test-browsers npx playwright test e2e/mk-edit-goals-prds.capture.spec.ts --workers=1
import fs from "node:fs"; // MOCK-HOOK
import path from "node:path"; // MOCK-HOOK

import { MOCK_ROLE_KEY, MOCK_SCENARIO_KEY } from "../lib/api/mock/server"; // MOCK-HOOK
import { THEME_KEY } from "../lib/theme"; // MOCK-HOOK
import { ADMIN, login } from "./helpers"; // MOCK-HOOK
import { MOCK_NOW } from "../lib/api/mock/clock"; // MOCK-HOOK
import { expect, test, type Browser, type Page } from "./test"; // MOCK-HOOK

const OUT = path.resolve(__dirname, "../../mockups-out/mk-edit-goals-prds"); // MOCK-HOOK
const ONLY = process.env.MK_ONLY ?? ""; // MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK
test.setTimeout(90_000); // MOCK-HOOK

const W = { d: { width: 1440, height: 900 }, h: { width: 1512, height: 900 }, p: { width: 390, height: 844 } } as const; // MOCK-HOOK
type Size = (typeof W)[keyof typeof W]; // MOCK-HOOK

// MOCK-HOOK: sign in as the given role (through the mock's role switch, so can() decides) on a scenario.
async function start(browser: Browser, size: Size, role: string, scenario = "simple-plan"): Promise<Page> { // MOCK-HOOK
  for (const c of browser.contexts()) await c.close(); // MOCK-HOOK
  const ctx = await browser.newContext({ viewport: size, baseURL: `http://localhost:${process.env.E2E_PORT ?? 3100}` }); // MOCK-HOOK
  await ctx.clock.install({ time: MOCK_NOW }); // MOCK-HOOK
  const page = await ctx.newPage(); // MOCK-HOOK
  await ctx.addInitScript(([sk, sv, tk, rk, rv]) => { localStorage.setItem(sk, sv); localStorage.setItem(tk, "light"); if (rv) localStorage.setItem(rk, rv); else localStorage.removeItem(rk); }, [MOCK_SCENARIO_KEY, scenario, THEME_KEY, MOCK_ROLE_KEY, role === "owner" ? "" : role] as const); // MOCK-HOOK
  await login(page, ADMIN.email); // MOCK-HOOK
  return page; // MOCK-HOOK
} // MOCK-HOOK

// MOCK-HOOK: one frame: the DOM cloned with its form state, every stylesheet inlined, scripts removed, fonts copied.
async function frame(page: Page, name: string, size: Size) { // MOCK-HOOK
  await page.waitForTimeout(350); // MOCK-HOOK
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true }); // MOCK-HOOK
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true }); // MOCK-HOOK
  const snap = await page.evaluate(() => { // MOCK-HOOK
    const css: string[] = []; // MOCK-HOOK
    for (const sh of Array.from(document.styleSheets)) { try { css.push(Array.from(sh.cssRules).map((r) => r.cssText).join("\n")); } catch { /* cross-origin */ } } // MOCK-HOOK
    const live = Array.from(document.querySelectorAll("input,textarea,select,details")); // MOCK-HOOK
    const clone = document.documentElement.cloneNode(true) as HTMLElement; // MOCK-HOOK
    const dead = Array.from(clone.querySelectorAll("input,textarea,select,details")); // MOCK-HOOK
    live.forEach((el, i) => { // MOCK-HOOK
      const d = dead[i]; // MOCK-HOOK
      if (el instanceof HTMLInputElement) { if (el.type === "checkbox" || el.type === "radio") { if (el.checked) d.setAttribute("checked", ""); else d.removeAttribute("checked"); } else d.setAttribute("value", el.value); } // MOCK-HOOK
      else if (el instanceof HTMLTextAreaElement) d.textContent = el.value; // MOCK-HOOK
      else if (el instanceof HTMLSelectElement) Array.from((d as HTMLSelectElement).options).forEach((o, j) => (j === el.selectedIndex ? o.setAttribute("selected", "") : o.removeAttribute("selected"))); // MOCK-HOOK
      else if (el instanceof HTMLDetailsElement) { if (el.open) d.setAttribute("open", ""); else d.removeAttribute("open"); } // MOCK-HOOK
    }); // MOCK-HOOK
    clone.querySelectorAll("script,link[rel=stylesheet],link[rel=preload],link[rel=modulepreload],link[as],noscript,next-route-announcer,nextjs-portal").forEach((e) => e.remove()); // MOCK-HOOK
    clone.querySelectorAll("style").forEach((e) => e.remove()); // MOCK-HOOK
    return { html: clone.outerHTML, css: css.join("\n"), y: Math.round(window.scrollY) }; // MOCK-HOOK
  }); // MOCK-HOOK
  let css = snap.css; // MOCK-HOOK
  const urls = [...new Set([...css.matchAll(/url\("?([^")]+\.(?:woff2?|ttf|otf))"?\)/g)].map((m) => m[1]))]; // MOCK-HOOK
  for (const u of urls) { // MOCK-HOOK
    const base = path.basename(u.split("?")[0]); // MOCK-HOOK
    const file = path.join(OUT, "assets", base); // MOCK-HOOK
    if (!fs.existsSync(file)) { const r = await page.request.get(new URL(u, page.url()).toString()); fs.writeFileSync(file, await r.body()); } // MOCK-HOOK
    css = css.split(u).join(`../assets/${base}`); // MOCK-HOOK
  } // MOCK-HOOK
  const hook = `<meta name="mockup-viewport" content="${size.width}x${size.height}"><style>${css}</style><script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);addEventListener("load",function(){scrollTo(0,${snap.y})})})()</script>`; // MOCK-HOOK
  const html = `<!doctype html>\n${snap.html.replace(/<head([^>]*)>/, `<head$1>${hook}`)}`; // MOCK-HOOK
  fs.writeFileSync(path.join(OUT, "frames", `${name}.html`), html); // MOCK-HOOK
  await page.screenshot({ path: path.join(OUT, "frames", `${name}.png`) }); // MOCK-HOOK
} // MOCK-HOOK

const BUCKETS = (eg: string) => `/simple/priorities?tab=buckets&eg=${eg}`; // MOCK-HOOK
const bucket = (page: Page, g: string) => page.locator(`[data-testid="plan-goal"][data-goal="${g}"]`); // MOCK-HOOK
async function buckets(page: Page, eg: string) { // MOCK-HOOK
  await page.goto(BUCKETS(eg)); // MOCK-HOOK
  await expect(bucket(page, "Reliability").getByTestId("goal-measure")).toBeVisible(); // MOCK-HOOK
} // MOCK-HOOK
async function toBucket(page: Page, g: string) { // MOCK-HOOK
  await bucket(page, g).evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 90)); // MOCK-HOOK
} // MOCK-HOOK
async function toEnd(page: Page, tid: string) { // MOCK-HOOK
  await page.getByTestId(tid).first().evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 40)); // MOCK-HOOK
} // MOCK-HOOK
const menu = (page: Page, g: string) => page.getByRole("button", { name: `More for ${g}` }); // MOCK-HOOK
const item = (page: Page, n: string) => page.getByRole("menuitem", { name: n }); // MOCK-HOOK
const dialog = (page: Page) => page.getByRole("dialog"); // MOCK-HOOK
const go = (n: string) => !ONLY || n.startsWith(ONLY); // MOCK-HOOK

// ---------------- Decision 1: goals ---------------- MOCK-HOOK
test("eg1-a", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-a")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await buckets(page, "a"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await frame(page, "eg1-a-rest", W.d); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Edit Growth" }).click(); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("combobox").last().selectOption("Hana Sato"); // MOCK-HOOK
  await frame(page, "eg1-a-owner", W.d); // MOCK-HOOK
  await page.getByRole("button", { name: "Save goal" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("bucket-note")).toBeVisible(); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await frame(page, "eg1-a-open", W.d); // MOCK-HOOK
  await item(page, "Archive goal").click(); // MOCK-HOOK
  await dialog(page).getByLabel("Goal", { exact: true }).selectOption({ index: 1 }); // MOCK-HOOK
  await frame(page, "eg1-a-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Archive goal" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("bucket-note")).toContainText("Archived Growth"); // MOCK-HOOK
  await page.getByTestId("mk-archived-goals").locator("summary").click(); // MOCK-HOOK
  await toEnd(page, "mk-archived-goals"); // MOCK-HOOK
  await frame(page, "eg1-a-result", W.d); // MOCK-HOOK
  await page.getByTestId("mk-archived-goal").nth(1).getByRole("button", { name: "Delete" }).click(); // MOCK-HOOK
  await frame(page, "eg1-a-delete", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-a-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-a")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "eg1-a-hard"], [W.h, "eg1-a-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner", "goal-buckets-hard"); // MOCK-HOOK
    await page.goto(BUCKETS("a")); // MOCK-HOOK
    await expect(bucket(page, "Grow partner network")).toBeVisible(); // MOCK-HOOK
    await menu(page, "Grow partner network").click(); // MOCK-HOOK
    await item(page, "Delete goal").click(); // MOCK-HOOK
    await dialog(page).getByLabel("Goal", { exact: true }).selectOption({ index: 1 }); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-a-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("eg1-a")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await buckets(page, "a"); // MOCK-HOOK
  await toBucket(page, "Growth"); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await frame(page, "eg1-a-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "approver"); // MOCK-HOOK
  await buckets(page, "a"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await frame(page, "eg1-a-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await buckets(page, "a"); // MOCK-HOOK
  await page.getByTestId("mk-archived-goals").locator("summary").click(); // MOCK-HOOK
  await toEnd(page, "mk-archived-goals"); // MOCK-HOOK
  await frame(page, "eg1-a-readonly", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-b", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-b")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await buckets(page, "b"); // MOCK-HOOK
  await frame(page, "eg1-b-rest", W.d); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Edit Growth" }).click(); // MOCK-HOOK
  await frame(page, "eg1-b-open", W.d); // MOCK-HOOK
  await page.getByTestId("mk-goal-sheet").getByRole("combobox").selectOption("Hana Sato"); // MOCK-HOOK
  await page.getByTestId("mk-goal-sheet").getByRole("button", { name: "Archive" }).click(); // MOCK-HOOK
  await dialog(page).getByLabel("Goal", { exact: true }).selectOption({ index: 1 }); // MOCK-HOOK
  await frame(page, "eg1-b-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Archive goal" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("bucket-note")).toContainText("Archived Growth"); // MOCK-HOOK
  await page.getByTestId("mk-show-archived").locator("input").check(); // MOCK-HOOK
  await page.getByTestId("mk-archived-bucket").first().evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 300)); // MOCK-HOOK
  await frame(page, "eg1-b-result", W.d); // MOCK-HOOK
  await page.getByTestId("mk-archived-bucket").nth(1).getByRole("button", { name: "Delete" }).click(); // MOCK-HOOK
  await frame(page, "eg1-b-delete", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Delete goal" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("bucket-note")).toContainText("Settings > Trash"); // MOCK-HOOK
  await page.getByTestId("bucket-note").evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 120)); // MOCK-HOOK
  await frame(page, "eg1-b-deleted", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-b-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-b")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "eg1-b-hard"], [W.h, "eg1-b-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner", "goal-buckets-hard"); // MOCK-HOOK
    await page.goto(BUCKETS("b")); // MOCK-HOOK
    await expect(bucket(page, "Grow partner network")).toBeVisible(); // MOCK-HOOK
    await page.getByTestId("mk-show-archived").locator("input").check(); // MOCK-HOOK
    await page.getByTestId("mk-archived-bucket").first().evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 500)); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-b-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("eg1-b")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await buckets(page, "b"); // MOCK-HOOK
  await toBucket(page, "Growth"); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Edit Growth" }).click(); // MOCK-HOOK
  await frame(page, "eg1-b-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "approver"); // MOCK-HOOK
  await buckets(page, "b"); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await item(page, "Open goal").click(); // MOCK-HOOK
  await frame(page, "eg1-b-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await buckets(page, "b"); // MOCK-HOOK
  await page.getByTestId("mk-show-archived").locator("input").check(); // MOCK-HOOK
  await page.getByTestId("mk-archived-bucket").first().evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 400)); // MOCK-HOOK
  await frame(page, "eg1-b-readonly", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-c", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-c")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await buckets(page, "c"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await frame(page, "eg1-c-rest", W.d); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Sam Okafor" }).click(); // MOCK-HOOK
  await frame(page, "eg1-c-open", W.d); // MOCK-HOOK
  await page.getByRole("menuitemradio", { name: "Hana Sato" }).click(); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await item(page, "Archive goal").click(); // MOCK-HOOK
  await dialog(page).getByLabel("Goal", { exact: true }).selectOption({ index: 1 }); // MOCK-HOOK
  await frame(page, "eg1-c-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Archive goal" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("bucket-note")).toContainText("Archived Growth"); // MOCK-HOOK
  await page.getByTestId("mk-archived-goals").locator("summary").click(); // MOCK-HOOK
  await toEnd(page, "mk-archived-goals"); // MOCK-HOOK
  await frame(page, "eg1-c-result", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-c-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("eg1-c")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "eg1-c-hard"], [W.h, "eg1-c-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner", "goal-buckets-hard"); // MOCK-HOOK
    await page.goto(BUCKETS("c")); // MOCK-HOOK
    await expect(bucket(page, "Grow partner network")).toBeVisible(); // MOCK-HOOK
    await menu(page, "Grow partner network").click(); // MOCK-HOOK
    await item(page, "Delete goal").click(); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("eg1-c-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("eg1-c")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await buckets(page, "c"); // MOCK-HOOK
  await toBucket(page, "Growth"); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Sam Okafor" }).click(); // MOCK-HOOK
  await frame(page, "eg1-c-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "approver"); // MOCK-HOOK
  await buckets(page, "c"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await bucket(page, "Growth").getByRole("button", { name: "Sam Okafor" }).click(); // MOCK-HOOK
  await frame(page, "eg1-c-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "commenter"); // MOCK-HOOK
  await buckets(page, "c"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await menu(page, "Growth").click(); // MOCK-HOOK
  await frame(page, "eg1-c-ask", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await buckets(page, "c"); // MOCK-HOOK
  await toBucket(page, "Reliability"); // MOCK-HOOK
  await frame(page, "eg1-c-readonly", W.d); // MOCK-HOOK
}); // MOCK-HOOK

// ---------------- Decision 2: PRDs ---------------- MOCK-HOOK
async function list(page: Page, ep: string) { // MOCK-HOOK
  await page.goto(`/simple/one-pagers?ep=${ep}`); // MOCK-HOOK
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible(); // MOCK-HOOK
} // MOCK-HOOK
async function paper(page: Page, ep: string) { // MOCK-HOOK
  await page.goto(`/simple/one-pagers/guided-setup?ep=${ep}`); // MOCK-HOOK
  await expect(page.getByTestId("one-pager")).toBeVisible(); // MOCK-HOOK
  await page.waitForTimeout(800); // MOCK-HOOK
} // MOCK-HOOK

test("ep2-a", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-a")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await list(page, "a"); // MOCK-HOOK
  await frame(page, "ep2-a-rest", W.d); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await frame(page, "ep2-a-open", W.d); // MOCK-HOOK
  await item(page, "Archive PRD").click(); // MOCK-HOOK
  await dialog(page).getByText("Keep them on the roadmap, with no PRD").click(); // MOCK-HOOK
  await frame(page, "ep2-a-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Archive PRD" }).click(); // MOCK-HOOK
  await page.getByTestId("mk-archived-prds").locator("summary").click(); // MOCK-HOOK
  await frame(page, "ep2-a-result", W.d); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Usage alerts before plan limits" }).click(); // MOCK-HOOK
  await item(page, "Delete PRD").click(); // MOCK-HOOK
  await dialog(page).getByText("Take them off the roadmap too").click(); // MOCK-HOOK
  await frame(page, "ep2-a-delete", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-a-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-a")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "ep2-a-hard"], [W.h, "ep2-a-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner"); // MOCK-HOOK
    await paper(page, "a"); // MOCK-HOOK
    await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-a-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("ep2-a")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await list(page, "a"); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await item(page, "Delete PRD").click(); // MOCK-HOOK
  await frame(page, "ep2-a-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "commenter"); // MOCK-HOOK
  await list(page, "a"); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await item(page, "Ask to archive").click(); // MOCK-HOOK
  await dialog(page).getByText("Keep them on the roadmap, with no PRD").click(); // MOCK-HOOK
  await frame(page, "ep2-a-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await list(page, "a"); // MOCK-HOOK
  await frame(page, "ep2-a-readonly", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-b", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-b")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await paper(page, "b"); // MOCK-HOOK
  await frame(page, "ep2-b-rest", W.d); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await frame(page, "ep2-b-open", W.d); // MOCK-HOOK
  await item(page, "Archive PRD").click(); // MOCK-HOOK
  await dialog(page).getByText("Take them off the roadmap too").click(); // MOCK-HOOK
  await frame(page, "ep2-b-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: "Archive PRD" }).click(); // MOCK-HOOK
  await expect(page.getByTestId("mk-prd-archived")).toBeVisible(); // MOCK-HOOK
  await frame(page, "ep2-b-result", W.d); // MOCK-HOOK
  await page.getByTestId("one-pager").getByRole("link", { name: "One-pagers", exact: true }).click(); // MOCK-HOOK
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible(); // MOCK-HOOK
  await page.getByText(/Show archived/).click(); // MOCK-HOOK
  await page.getByTestId("mk-archived-prd").last().scrollIntoViewIfNeeded(); // MOCK-HOOK
  await frame(page, "ep2-b-list", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-b-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-b")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "ep2-b-hard"], [W.h, "ep2-b-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner"); // MOCK-HOOK
    await paper(page, "b"); // MOCK-HOOK
    await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
    await item(page, "Delete PRD").click(); // MOCK-HOOK
    await dialog(page).getByText("Take them off the roadmap too").click(); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-b-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("ep2-b")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await paper(page, "b"); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await frame(page, "ep2-b-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "commenter"); // MOCK-HOOK
  await paper(page, "b"); // MOCK-HOOK
  await page.getByRole("button", { name: "More for Guided setup" }).click(); // MOCK-HOOK
  await frame(page, "ep2-b-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await paper(page, "b"); // MOCK-HOOK
  await frame(page, "ep2-b-readonly", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-c", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-c")); // MOCK-HOOK
  const page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await list(page, "c"); // MOCK-HOOK
  await frame(page, "ep2-c-rest", W.d); // MOCK-HOOK
  await page.getByTestId("mk-select").click(); // MOCK-HOOK
  for (const t of ["Printable weekly reports", "Capture notes from a phone", "Billing history page"]) await page.getByRole("checkbox", { name: `Select ${t}` }).check(); // MOCK-HOOK
  await frame(page, "ep2-c-open", W.d); // MOCK-HOOK
  await page.getByTestId("mk-select-bar").getByRole("button", { name: "Archive" }).click(); // MOCK-HOOK
  await dialog(page).getByText("Keep them on the roadmap, with no PRD").click(); // MOCK-HOOK
  await frame(page, "ep2-c-mid", W.d); // MOCK-HOOK
  await dialog(page).getByRole("button", { name: /Archive 3 PRDs/ }).click(); // MOCK-HOOK
  await page.getByTestId("mk-archived-prds").locator("summary").click(); // MOCK-HOOK
  await frame(page, "ep2-c-result", W.d); // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-c-hard", async ({ browser }) => { // MOCK-HOOK
  test.skip(!go("ep2-c")); // MOCK-HOOK
  for (const [s, n] of [[W.d, "ep2-c-hard"], [W.h, "ep2-c-hard-1512"]] as const) { // MOCK-HOOK
    const page = await start(browser, s, "owner"); // MOCK-HOOK
    await list(page, "c"); // MOCK-HOOK
    await page.getByTestId("mk-select").click(); // MOCK-HOOK
    const boxes = page.getByRole("checkbox", { name: /^Select / }); // MOCK-HOOK
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check(); // MOCK-HOOK
    await page.getByTestId("mk-select-bar").getByRole("button", { name: "Delete" }).click(); // MOCK-HOOK
    await dialog(page).getByText("Take them off the roadmap too").click(); // MOCK-HOOK
    await frame(page, n, s); // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK

test("ep2-c-roles", async ({ browser }) => { // MOCK-HOOK
  let page: Page; // MOCK-HOOK
  test.skip(!go("ep2-c")); // MOCK-HOOK
  page = await start(browser, W.p, "owner"); // MOCK-HOOK
  await list(page, "c"); // MOCK-HOOK
  await page.getByTestId("mk-select").click(); // MOCK-HOOK
  await page.getByRole("checkbox", { name: "Select Import customers from a CSV file" }).check(); // MOCK-HOOK
  await page.getByRole("checkbox", { name: "Select Guided setup" }).check(); // MOCK-HOOK
  await page.getByRole("checkbox", { name: "Select Import customers from a CSV file" }).evaluate((e) => { const bar = document.querySelector("[data-testid=mk-select-bar]")!.getBoundingClientRect(); window.scrollTo(0, e.closest("li")!.getBoundingClientRect().top + window.scrollY - bar.height - 60); }); // MOCK-HOOK
  await frame(page, "ep2-c-phone", W.p); // MOCK-HOOK
  page = await start(browser, W.d, "commenter"); // MOCK-HOOK
  await list(page, "c"); // MOCK-HOOK
  await page.getByTestId("mk-select").click(); // MOCK-HOOK
  await page.getByRole("checkbox", { name: "Select Billing history page" }).check(); // MOCK-HOOK
  await frame(page, "ep2-c-propose", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "viewer"); // MOCK-HOOK
  await list(page, "c"); // MOCK-HOOK
  await frame(page, "ep2-c-readonly", W.d); // MOCK-HOOK
  page = await start(browser, W.d, "owner"); // MOCK-HOOK
  await paper(page, "c"); // MOCK-HOOK
  await frame(page, "ep2-c-page", W.d); // MOCK-HOOK
}); // MOCK-HOOK
