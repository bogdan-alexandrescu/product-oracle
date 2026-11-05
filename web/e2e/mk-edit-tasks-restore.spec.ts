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
  await page.waitForTimeout(450);
  const vp = page.viewportSize()!;
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
    const all = document.querySelectorAll("*");
    const copy = doc.querySelectorAll("*");
    const head = doc.querySelector("head");
    all.forEach((el, i) => {
      if ((el.scrollTop || el.scrollLeft) && copy[i]) copy[i].setAttribute("data-mk-scroll", `${el.scrollLeft},${el.scrollTop}`);
    });
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
    `addEventListener("DOMContentLoaded",function(){document.querySelectorAll("[data-mk-scroll]").forEach(function(e){var p=e.getAttribute("data-mk-scroll").split(",");e.scrollLeft=+p[0];e.scrollTop=+p[1];});});})();</script>`;
  fs.writeFileSync(`${OUT}/frames/${name}.html`, "<!doctype html>" + r.html.replace("<head>", `<head>${extra}`));
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
  await page.getByLabel("Email").fill("admin@example.com");
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
  page.getByTestId("card-tasks").first().evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    let p = el.parentElement;
    while (p && p.scrollHeight <= p.clientHeight + 2) p = p.parentElement;
    if (p) p.scrollTop -= 24;
  });
const tasks = (page: Page) => page.getByTestId("card-tasks").first();
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
    open: async (p) => tasks(p).getByRole("button", { name: "More for Add an unsubscribe link to each digest" }).click(),
    mid: async (p) => {
      await tasks(p).getByRole("button", { name: "More for Add an unsubscribe link to each digest" }).click();
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
      await tasks(p).getByLabel("Due").fill("2026-11-02");
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
    // A phone: the panel is a bottom sheet.
    await page.setViewportSize(PHONE);
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
    await page.getByTestId("card-proposals").first().evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
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
const center = (page: Page, testId: string) => page.getByTestId(testId).first().evaluate((el) => el.scrollIntoView({ block: "center" }));

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
  await page.getByTestId("item-cut").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored Alert routing by team").first()).toBeVisible();
  await snap(page, "ec2-c-result");
  await page.setViewportSize(PHONE);
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByTestId("mk-removed-button").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await snap(page, "ec2-c-open-phone");
  await page.setViewportSize(DESK);
  await signOutIn(page, "commenter");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByRole("dialog", { name: "Removed" }).getByRole("button", { name: "Alert routing by team" }).click();
  await page.getByTestId("item-cut").first().waitFor();
  await snap(page, "ec2-c-propose");
  await signOutIn(page, "viewer");
  await page.goto("/simple/roadmap?roadmap=alerts-roadmap&ec2=c&open=1");
  await page.getByRole("dialog", { name: "Removed" }).waitFor();
  await snap(page, "ec2-c-readonly");
});

test("ec2 d", async ({ page }) => {
  await page.setViewportSize(DESK);
  await signIn(page);
  await openDigest(page, "ec2=d");
  await center(page, "mk-cut-delete");
  await snap(page, "ec2-d-rest");
  await page.getByRole("button", { name: "More…" }).click();
  await snap(page, "ec2-d-open");
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  await center(page, "mk-cut-delete");
  await snap(page, "ec2-d-mid");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Weekly alert digest is in Trash").first()).toBeVisible();
  await snap(page, "ec2-d-result");
  await page.goto("/settings/trash?ec2=d");
  await expect(page.getByText("Deleted from plans")).toBeVisible();
  await snap(page, "ec2-d-trash");
  await page.setViewportSize(WIDE);
  await page.getByText("Deleted from plans").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await snap(page, "ec2-d-trash-1512");
  await page.setViewportSize(PHONE);
  await openDigest(page, "ec2=d&menu=1");
  await center(page, "mk-cut-delete");
  await snap(page, "ec2-d-open-phone");
});

test("ec2 d roles", async ({ page }) => {
  await page.setViewportSize(DESK);
  await signIn(page, "commenter");
  await openDigest(page, "ec2=d&menu=1");
  await center(page, "mk-cut-delete");
  await snap(page, "ec2-d-propose");
  await signOutIn(page, "viewer");
  await openDigest(page, "ec2=d");
  await page.getByTestId("fp-read-only").first().waitFor();
  await snap(page, "ec2-d-readonly");
});
