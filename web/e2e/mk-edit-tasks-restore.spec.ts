// MOCK-HOOK mk-edit-tasks-restore: drives each proposal's story through the UI and saves every
// frame as a static html file (stylesheets inlined, scripts removed, fonts in assets/) and a PNG.
// Mock-ups only; run with MK_FRAMES=1.
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./test";

const OUT = path.resolve(__dirname, "../../mockups-out/mk-edit-tasks-restore"); // MOCK-HOOK
const DESK = { width: 1440, height: 900 }; // MOCK-HOOK
const WIDE = { width: 1512, height: 900 }; // MOCK-HOOK the owner's own window
const PHONE = { width: 390, height: 844 }; // MOCK-HOOK

test.skip(!process.env.MK_FRAMES, "MOCK-HOOK: frames only on demand"); // MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK scrollbars shown
test.setTimeout(240_000); // MOCK-HOOK

async function snap(page: Page, name: string) {
  // MOCK-HOOK
  const vp = page.viewportSize()!;
  // MOCK-HOOK: the pointer off the page's controls, so the PNG shows no hover the copy cannot keep.
  await page.mouse.move(vp.width - 1, vp.height - 1);
  await page.waitForTimeout(450);
  fs.mkdirSync(`${OUT}/frames`, { recursive: true });
  fs.mkdirSync(`${OUT}/assets`, { recursive: true });
  const r = await page.evaluate(() => {
    let css = "";
    for (const sh of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sh.cssRules))
          css += rule.cssText.replace(/url\((['"]?)(?!data:|#)([^'")]+)\1\)/g, (_m, _q, u: string) => `url(${new URL(u, sh.href ?? location.href).href})`) + "\n";
      } catch {
        /* a sheet from elsewhere */
      }
    }
    const doc = document.documentElement.cloneNode(true) as HTMLElement;
    const src = document.querySelectorAll("input, select, textarea");
    const dst = doc.querySelectorAll("input, select, textarea");
    src.forEach((el, i) => {
      const d = dst[i] as HTMLElement | undefined;
      if (!d) return;
      if (el instanceof HTMLSelectElement) Array.from((d as HTMLSelectElement).options).forEach((o, j) => (j === el.selectedIndex ? o.setAttribute("selected", "") : o.removeAttribute("selected")));
      else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) (el.checked ? d.setAttribute("checked", "") : d.removeAttribute("checked"));
      else if (el instanceof HTMLTextAreaElement) d.textContent = el.value;
      else d.setAttribute("value", (el as HTMLInputElement).value);
    });
    // Scrolled boxes keep where they were scrolled to.
    const all = [document.documentElement, ...Array.from(document.documentElement.querySelectorAll("*"))];
    const copy = [doc, ...Array.from(doc.querySelectorAll("*"))]; // MOCK-HOOK the clone itself first, as in all
    const head = doc.querySelector("head");
    const at = new Map(all.map((el, i) => [el, i]));
    // MOCK-HOOK: a box that scrolls for itself (not one that only clips).
    const scrolls = (e: Element) => e === document.documentElement || (e.scrollHeight > e.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    const topOf = (c: Element) => (c === document.documentElement ? 0 : c.getBoundingClientRect().top + c.clientTop);
    all.forEach((el, i) => {
      if (!((el.scrollTop || el.scrollLeft) && copy[i])) return;
      copy[i].setAttribute("data-mk-scroll", `${el.scrollLeft},${el.scrollTop}`);
      if (!el.scrollTop || !scrolls(el)) return;
      // MOCK-HOOK: the scroll is kept as an element and its distance from the box's top (the Tasks heading when it
      // shows, else the first named part at the top), so a copy whose heights differ still opens on the same thing.
      const top = topOf(el);
      const own = (e: Element) => {
        for (let p = e.parentElement; p && p !== el; p = p.parentElement) if (p.scrollTop && scrolls(p)) return false;
        return true;
      };
      const seen = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.height > 0 && r.top >= top - 1 && r.top < top + el.clientHeight * 0.6 && own(e);
      };
      const tasks = Array.from(el.querySelectorAll('[data-testid="card-tasks"] h3, [data-testid="card-tasks"]')).find(seen);
      const anchor = tasks ?? Array.from(el.querySelectorAll("[data-testid], h1, h2, h3")).filter(seen).sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top)[0];
      const k = at.get(anchor!);
      if (anchor && k !== undefined && copy[k]) {
        copy[i].setAttribute("data-mk-key", `k${i}`);
        copy[k].setAttribute("data-mk-anchor", `k${i}:${Math.round(anchor.getBoundingClientRect().top - top)}`);
      }
    });
    // MOCK-HOOK: the focus ring the PNG shows, kept on the copy (it has no :focus), in the theme's own colours.
    const f = document.activeElement;
    const fk = f ? at.get(f) : undefined;
    if (f && fk !== undefined && copy[fk] && f !== document.body) {
      const probe = document.createElement("i");
      document.body.append(probe);
      const vars = ["--color-accent", "--color-line-strong", "--color-line"].map((v) => {
        probe.style.color = `var(${v})`;
        return [getComputedStyle(probe).color, `var(${v})`];
      });
      probe.remove();
      const cs = getComputedStyle(f);
      const ring = ["outline-style", "outline-width", "outline-color", "outline-offset", "box-shadow", "border-color"]
        .map((p) => `${p}:${vars.reduce((v, [rgb, name]) => v.split(rgb).join(name), cs.getPropertyValue(p))}`)
        .join(";");
      copy[fk].setAttribute("style", `${copy[fk].getAttribute("style") ?? ""};${ring}`);
    }
    doc.querySelectorAll("script, link[rel=stylesheet], link[rel=preload], link[rel=modulepreload], style, noscript, next-route-announcer").forEach((n) => n.remove());
    void head;
    return { css, html: doc.outerHTML };
  });
  const urls = new Set<string>();
  const css = r.css.replace(/url\(([^)]+)\)/g, (m, u: string) => {
    const s = u.replace(/^['"]|['"]$/g, "");
    if (s.startsWith("data:") || s.startsWith("#")) return m;
    urls.add(s);
    return `url(../assets/${path.basename(s.split("?")[0])})`;
  });
  for (const u of urls) {
    const file = `${OUT}/assets/${path.basename(u.split("?")[0])}`;
    if (fs.existsSync(file)) continue;
    const res = await page.request.get(new URL(u, page.url()).toString());
    if (res.ok()) fs.writeFileSync(file, await res.body());
  }
  const extra =
    `<meta name="mockup-viewport" content="${vp.width}x${vp.height}">` +
    `<style>${css}</style>` +
    `<script>(function(){var t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.setAttribute("data-theme",t);` +
    // MOCK-HOOK: scrolled again once the fonts are in, as they change the heights above.
    `function s(){var d=document.documentElement;document.querySelectorAll("[data-mk-scroll]").forEach(function(e){var p=e.getAttribute("data-mk-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1];` +
    // MOCK-HOOK: then its anchor is brought to where it sat, as scrollIntoView would, inside this box only.
    `var k=e.getAttribute("data-mk-key"),a=k&&document.querySelector('[data-mk-anchor^="'+k+':"]');if(a){var t=e===d?0:e.getBoundingClientRect().top+e.clientTop;e.scrollTop+=a.getBoundingClientRect().top-t-Number(a.getAttribute("data-mk-anchor").split(":")[1]);}});}` +
    `addEventListener("DOMContentLoaded",s);addEventListener("load",s);document.fonts&&document.fonts.ready.then(s);})();</script>`;
  const html = "<!doctype html>" + r.html.replace(/<head([^>]*)>/, (m) => m + extra); // MOCK-HOOK
  expect(html.includes("<style>") && html.includes('name="mockup-viewport"'), `${name}: styles and viewport inlined`).toBe(true); // MOCK-HOOK
  fs.writeFileSync(`${OUT}/frames/${name}.html`, html);
  await page.screenshot({ path: `${OUT}/frames/${name}.png` });
}

async function signIn(page: Page, role?: "commenter" | "viewer") {
  // MOCK-HOOK: the scenario's data, and the role through the mock's own switch.
  await page.goto("/login?next=%2Fhome");
  await page.evaluate((role) => {
    localStorage.clear();
    localStorage.setItem("po-mock-scenario", "mk-edit-tasks");
    if (role) localStorage.setItem("po-mock-role", role);
  }, role ?? null);
  await page.reload();
  // MOCK-HOOK: a commenter or viewer is another invented person than the feature's decider (Avery Stone).
  await page.getByLabel("Email").fill(role ? `${role}@example.com` : "admin@example.com");
  await page.getByLabel("Password").fill(["de", "mo"].join(""));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function openDigest(page: Page, q: string) {
  // MOCK-HOOK: the Roadmap, then the digest's bar (a phone: its row in the lane list).
  await page.goto(`/simple/roadmap?roadmap=alerts-roadmap&${q}`);
  const bar = page.locator('[data-testid="timeline-row"][data-item="alert-digest"] [data-testid="timeline-bar"]').first();
  if ((page.viewportSize()?.width ?? 0) < 600) {
    const row = page.getByText("Weekly alert digest").first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
  } else {
    await bar.scrollIntoViewIfNeeded();
    await bar.click();
  }
  await page.getByTestId("card-tasks").first().waitFor();
  await tasksInView(page);
}
const tasksInView = (page: Page) =>
  // MOCK-HOOK: the panel's own scroll box puts the Tasks heading just under its sticky header, no half line above it.
  page.getByTestId("card-tasks").first().evaluate((el) => {
    let p = el.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (!p) return;
    const sticky = Array.from(p.querySelectorAll("*")).find((e) => getComputedStyle(e).position === "sticky" && !e.contains(el));
    const top = sticky ? sticky.getBoundingClientRect().bottom : p.getBoundingClientRect().top;
    p.scrollTop += el.getBoundingClientRect().top - top - 8;
  });
const tasks = (page: Page) => page.getByTestId("card-tasks").first();
// MOCK-HOOK: the panel's scroll box starts on a whole row or heading, never a half one under its sticky header.
const wholeTop = (page: Page) =>
  page.getByTestId("card-tasks").first().evaluate((el) => {
    let p = el.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (!p) return;
    const sticky = Array.from(p.querySelectorAll("*")).find((e) => getComputedStyle(e).position === "sticky");
    const top = sticky ? sticky.getBoundingClientRect().bottom : p.getBoundingClientRect().top;
    const cut = Array.from(p.querySelectorAll("li, h3, p, dt, dd")).find((e) => {
      const r = e.getBoundingClientRect();
      return r.top < top && r.bottom > top && r.height < 120;
    });
    if (cut) p.scrollTop += cut.getBoundingClientRect().top - top - 1;
  });
const NEW = "Send a test digest to the support team"; // MOCK-HOOK

// MOCK-HOOK Decision 1: each proposal's story.
const EC1: Record<string, { open: (p: Page) => Promise<void>; mid: (p: Page) => Promise<void>; done: (p: Page) => Promise<void> }> = {
  a: {
    open: async (p) => tasks(p).getByRole("button", { name: "Change the owner of Check how it reads on a phone" }).click(),
    mid: async (p) => {
      await tasks(p).getByRole("option", { name: "Lena Ortiz" }).click({ timeout: 3000 }).catch(() => tasks(p).getByRole("option", { name: "No owner" }).click());
      await tasks(p).getByRole("button", { name: "+ Add a task" }).click();
      await tasks(p).getByLabel("New task").fill(NEW);
    },
    done: async (p) => tasks(p).getByLabel("New task").press("Enter"),
  },
  b: {
    open: async (p) => tasks(p).getByRole("button", { name: "More for Check how it reads on a phone" }).click(),
    mid: async (p) => {
      await tasks(p).getByRole("button", { name: "More for Check how it reads on a phone" }).click();
      await tasks(p).getByLabel("New task").fill(NEW);
    },
    done: async (p) => tasks(p).getByLabel("New task").press("Enter"),
  },
  c: {
    open: async (p) => tasks(p).getByRole("button", { name: "More for Add an unsubscribe link to each digest" }).click(),
    mid: async (p) => {
      await tasks(p).getByRole("button", { name: "More for Add an unsubscribe link to each digest" }).click();
      await tasks(p).getByRole("button", { name: "Add a task" }).click();
      await tasks(p).getByLabel("Task", { exact: true }).fill(NEW);
      await tasks(p).getByLabel("Owner").selectOption({ label: "Lena Ortiz" }, { timeout: 3000 }).catch(() => undefined);
      await tasks(p).getByLabel("Due").fill("Nov 2");
    },
    done: async (p) => tasks(p).getByRole("button", { name: /^(Add|Propose)$/ }).click(),
  },
  d: {
    open: async (p) => tasks(p).getByRole("button", { name: "Edit tasks" }).click(),
    mid: async (p) => {
      await tasks(p).getByLabel("Status").nth(3).selectOption("done");
      await tasks(p).getByRole("button", { name: "Add a row" }).click();
      await tasks(p).getByLabel("New task").fill(NEW);
    },
    done: async (p) => tasks(p).getByRole("button", { name: /^(Save all|Propose all)$/ }).click(),
  },
};

for (const v of Object.keys(EC1)) {
  test(`ec1 ${v}`, async ({ page }) => {
    const s = EC1[v];
    await page.setViewportSize(DESK);
    await signIn(page);
    await openDigest(page, `ec1=${v}`);
    await snap(page, `ec1-${v}-rest`);
    await s.open(page);
    await snap(page, `ec1-${v}-open`);
    await s.mid(page);
    await snap(page, `ec1-${v}-mid`);
    await page.setViewportSize(WIDE);
    await snap(page, `ec1-${v}-mid-1512`);
    await page.setViewportSize(DESK);
    await s.done(page);
    await expect(tasks(page).getByText(NEW).first()).toBeVisible();
    await tasksInView(page);
    await snap(page, `ec1-${v}-result`);
    if (v === "a") {
      // MOCK-HOOK: dropping a task: the status picker's last choice; the toast says it went to Trash, with Undo.
      await page.getByRole("button", { name: "Dismiss" }).first().click();
      await tasks(page).getByRole("button", { name: "Status of Check how it reads on a phone" }).click();
      await snap(page, "ec1-a-drop-open");
      await tasks(page).getByRole("option", { name: "Drop this task" }).click();
      await expect(page.getByText("“Check how it reads on a phone” went to Trash").first()).toBeVisible();
      await expect(tasks(page).getByText("Check how it reads on a phone")).toHaveCount(0);
      await snap(page, "ec1-a-drop-result");
    }
    // A phone: the panel is a bottom sheet, on a fresh start.
    await page.setViewportSize(PHONE);
    await page.context().clearCookies();
    await signIn(page);
    await openDigest(page, `ec1=${v}`);
    await s.open(page);
    await snap(page, `ec1-${v}-open-phone`);
  });
  test(`ec1 ${v} roles`, async ({ page }) => {
    const s = EC1[v];
    await page.setViewportSize(DESK);
    await signIn(page, "commenter");
    await openDigest(page, `ec1=${v}`);
    await s.open(page);
    await s.mid(page);
    await s.done(page);
    for (let i = 0; i < 4; i++) {
      // MOCK-HOOK each queued toast off the proposals
      await page.waitForTimeout(250);
      if (!(await page.getByRole("button", { name: "Dismiss" }).count())) break;
      await page.getByRole("button", { name: "Dismiss" }).first().click().catch(() => undefined);
    }
    // MOCK-HOOK: the proposals whole.
    await page.getByTestId("card-proposals").first().evaluate((el) => {
      el.scrollIntoView({ block: "end" });
      let p = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (p) p.scrollTop += 90;
    }).catch(() => undefined);
    await wholeTop(page);
    await snap(page, `ec1-${v}-propose`);
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await signIn(page, "viewer");
    await openDigest(page, `ec1=${v}`);
    await snap(page, `ec1-${v}-readonly`);
  });
}

// MOCK-HOOK Decision 2: each proposal's story.
async function signOutIn(page: Page, role: "commenter" | "viewer") {
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await signIn(page, role);
}
// MOCK-HOOK: the page at its top when the part fits there (the heading whole), else the part at the top.
const center = (page: Page, testId: string) =>
  page.getByTestId(testId).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top + scrollY < innerHeight * 0.4) return window.scrollTo(0, 0);
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -72);
  });

test("ec2 a", async ({ page }) => {
  await page.setViewportSize(DESK);
  await signIn(page);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=a");
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-rest");
  await page.getByRole("switch").click();
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-open");
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByText("Restored Alert routing by team").first()).toBeVisible();
  await snap(page, "ec2-a-result");
  await page.setViewportSize(WIDE);
  await page.goto("/simple/roadmap?roadmap=onboarding-roadmap&ec2=a&removed=1");
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-open-1512");
  await page.setViewportSize(PHONE);
  await page.goto("/simple/roadmap?roadmap=onboarding-roadmap&ec2=a&removed=1");
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-open-phone");
  await page.setViewportSize(DESK);
  await signOutIn(page, "commenter");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=a&removed=1");
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-propose");
  await signOutIn(page, "viewer");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=a&removed=1");
  await center(page, "mk-show-removed");
  await snap(page, "ec2-a-readonly");
});

test("ec2 b", async ({ page }) => {
  await page.setViewportSize(DESK);
  await signIn(page);
  await page.goto("/settings/trash?ec2=b");
  await expect(page.getByText("Removed from plans")).toBeVisible();
  await snap(page, "ec2-b-rest");
  await page.getByRole("button", { name: /^Features/ }).click();
  await snap(page, "ec2-b-open");
  await page.getByRole("button", { name: "Restore" }).last().click();
  await snap(page, "ec2-b-result");
  await page.setViewportSize(WIDE);
  await page.goto("/settings/trash?ec2=b");
  await expect(page.getByText("Removed from plans")).toBeVisible();
  await page.getByText("Removed from plans").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await snap(page, "ec2-b-rest-1512");
  await page.setViewportSize(PHONE);
  await page.goto("/settings/trash?ec2=b");
  await page.getByText("Removed from plans").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await snap(page, "ec2-b-rest-phone");
  await page.setViewportSize(DESK);
  await signOutIn(page, "commenter");
  await page.goto("/settings/trash?ec2=b");
  await snap(page, "ec2-b-propose");
});

test("ec2 c", async ({ page }) => {
  // MOCK-HOOK: restore from the Removed list; a cut feature's panel only says who cut it (its Restore is in the header menu another set draws).
  await page.setViewportSize(DESK);
  await signIn(page);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c");
  await page.getByTestId("mk-removed-button").waitFor();
  await snap(page, "ec2-c-rest");
  await page.getByTestId("mk-removed-button").getByRole("button", { name: /^Removed/ }).click();
  await snap(page, "ec2-c-open");
  await page.setViewportSize(WIDE);
  await snap(page, "ec2-c-open-1512");
  await page.setViewportSize(DESK);
  await page.getByRole("dialog", { name: "Removed" }).getByRole("button", { name: "Alert routing by team" }).click();
  await page.getByTestId("item-cut").first().waitFor();
  await snap(page, "ec2-c-mid");
  await page.getByRole("button", { name: "Close" }).first().click();
  await page.getByTestId("mk-removed-button").getByRole("button", { name: /^Removed/ }).click();
  await page.getByRole("dialog", { name: "Removed" }).getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByText("Restored Alert routing by team").first()).toBeVisible();
  await expect(page.getByTestId("mk-removed-button").getByRole("button", { name: "Removed · 5" })).toBeVisible();
  // MOCK-HOOK: the list closed, the restored feature back on the timeline.
  await expect(page.getByRole("dialog", { name: "Removed" })).toHaveCount(0);
  await expect(page.locator('[data-testid="timeline-row"]').filter({ hasText: "Alert routing by team" }).first()).toBeVisible();
  await snap(page, "ec2-c-result");
  await page.setViewportSize(PHONE);
  await page.context().clearCookies();
  await signIn(page);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByTestId("mk-removed-button").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await snap(page, "ec2-c-open-phone");
  await page.setViewportSize(DESK);
  await signOutIn(page, "commenter");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByRole("dialog", { name: "Removed" }).waitFor();
  await snap(page, "ec2-c-propose");
  await signOutIn(page, "viewer");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByRole("dialog", { name: "Removed" }).waitFor();
  await snap(page, "ec2-c-readonly");
});

// MOCK-HOOK: every saved frame opens styled, inside its own width, where its PNG was taken, light and dark.
test("frames open as their PNGs", async ({ page }) => {
  const dir = `${OUT}/frames`;
  const look = process.env.MK_LOOK; // MOCK-HOOK a folder for the light and dark shots to look at
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html")).sort()) {
    const html = fs.readFileSync(`${dir}/${f}`, "utf8");
    const [w, h] = /name="mockup-viewport" content="(\d+)x(\d+)"/.exec(html)!.slice(1).map(Number);
    await page.setViewportSize({ width: w, height: h });
    for (const theme of ["light", "dark"]) {
      await page.goto(`file://${dir}/${f}?theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({
        wide: document.documentElement.scrollWidth,
        // MOCK-HOOK: each scrolled box reached the scroll asked, and its anchor sits where it sat in the PNG.
        off: Array.from(document.querySelectorAll("[data-mk-scroll]")).flatMap((e) => {
          const [x, y] = e.getAttribute("data-mk-scroll")!.split(",").map(Number);
          const k = e.getAttribute("data-mk-key");
          const a = k ? document.querySelector(`[data-mk-anchor^="${k}:"]`) : null;
          const t = e === document.documentElement ? 0 : e.getBoundingClientRect().top + e.clientTop;
          const moved = a ? Math.round(a.getBoundingClientRect().top - t - Number(a.getAttribute("data-mk-anchor")!.split(":")[1])) : 0;
          return Math.abs(e.scrollLeft - x) > 2 || Math.abs(e.scrollTop - y) > 2 || Math.abs(moved) > 2 ? [`${e.tagName} asked ${x},${y} reached ${e.scrollLeft},${e.scrollTop} anchor off ${moved}`] : [];
        }),
      }));
      expect.soft(r.wide, `${f} lays out inside ${w}px`).toBeLessThanOrEqual(w);
      expect.soft(r.off, `${f} ${theme} opens where its PNG was taken`).toEqual([]);
      if (process.env.MK_LOG) fs.appendFileSync(process.env.MK_LOG, `${f} ${theme} ${w}x${h} ${r.off.length ? r.off.join("; ") : "ok"}\n`); // MOCK-HOOK
      if (look) await page.screenshot({ path: `${look}/${f.replace(".html", "")}--${theme}.png` });
    }
  }
});
