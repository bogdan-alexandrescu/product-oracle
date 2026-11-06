// The built page in each ps1-a frame's state, light and dark.
import { chromium } from "playwright";
const [base, out] = process.argv.slice(2);
const OP = "/simple/one-pagers/guided-setup";
const STATES = [
  ["list-1512", "/simple/one-pagers", [1512, 900], {}],
  ["top-1512", OP, [1512, 900], {}],
  ["long-1512", OP, [1512, 900], { to: "glossary" }],
  ["edit-1512", OP, [1512, 900], { act: "edit" }],
  ["saved-1512", OP, [1512, 900], { act: "saved" }],
  ["feature-1512", OP, [1512, 900], { act: "feature" }],
  ["hard-1512", OP, [1512, 900], { to: "glossary" }],
  ["hard-1440", OP, [1440, 900], { to: "glossary" }],
  ["viewer-1512", OP, [1512, 900], { email: "viewer@example.com" }],
  ["dark-1512", OP, [1512, 900], { to: "risks" }],
  ["phone-top-390", OP, [390, 844], { phone: true }],
  ["phone-table-390", OP, [390, 844], { phone: true, to: "glossary" }],
  ["present-1512", OP, [1512, 900], { act: "present" }],
  ["cost-1440", OP, [1440, 900], { to: "later" }],
];
const b = await chromium.launch();
for (const [name, path, [w, h], o] of STATES) {
  for (const theme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: o.phone ? 2 : 1, isMobile: !!o.phone, hasTouch: !!o.phone, timezoneId: "America/Los_Angeles" });
    await ctx.addInitScript((t) => localStorage.setItem("oracle-theme", t), theme);
    await ctx.clock.install({ time: new Date("2026-11-04T17:00:00Z") });
    const page = await ctx.newPage();
    await page.goto(base + "/login?next=%2Fhome");
    await page.getByLabel("Email").fill(o.email ?? "admin@example.com");
    await page.getByLabel("Password").fill("demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/home$/);
    await page.goto(base + path);
    await page.waitForTimeout(2500);
    if (o.to) { await page.locator(`[data-prd-sec="${o.to}"]`).evaluate((el) => el.scrollIntoView({ block: "start" })); await page.waitForTimeout(500); }
    if (o.act === "present") await page.getByRole("button", { name: "Present" }).click();
    if (o.act === "feature") await page.locator('[data-line="risks-3"] .simple-prd-code').click();
    if (o.act === "edit" || o.act === "saved") {
      const edit = page.getByRole("button", { name: /^Edit “Single sign-on/ });
      await edit.scrollIntoViewIfNeeded();
      await page.locator('[data-line="not_doing-1"]').hover();
      await edit.click();
      await page.getByLabel("New wording for").fill("Single sign-on setup, in this release.");
      if (o.act === "saved") await page.getByRole("button", { name: "Save" }).click();
    }
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/ps1-a-${name}-${theme}.png` });
    await ctx.close();
  }
}
await b.close();
