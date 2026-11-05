// MOCK-HOOK: this whole file checks the mk-edit-decisions mock-up frames (never merged): each HTML at its own viewport, light and dark.
// MOCK-HOOK: MK_VERIFY=<served url of mockups-out/mk-edit-decisions/> MK_RENDER=<folder> npx playwright test e2e/mk-edit-decisions.verify.spec.ts --workers=1
import fs from "node:fs";
import path from "node:path";

import { test } from "@playwright/test";

const FRAMES = path.resolve(__dirname, "../../mockups-out/mk-edit-decisions/frames");
const BASE = process.env.MK_VERIFY ?? "";
const OUT = process.env.MK_RENDER ?? "";
const ONLY = process.env.MK_ONLY ?? "";

test.skip(!BASE || !OUT, "mock-up check only");
test.setTimeout(30 * 60_000);
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("render mk-edit-decisions frames", async ({ browser }) => {
  const names = fs.readdirSync(FRAMES).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).filter((n) => !ONLY || new RegExp(ONLY).test(n));
  for (const n of names) {
    const html = fs.readFileSync(path.join(FRAMES, `${n}.html`), "utf8");
    const [, w, h] = html.match(/mockup-viewport" content="(\d+)x(\d+)/)!;
    const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) } });
    const page = await ctx.newPage();
    for (const theme of ["light", "dark"]) {
      await page.goto(`${BASE}frames/${n}.html`);
      if (html.includes("#mk-at")) await page.waitForFunction(() => location.hash === "#mk-at");
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${n}-${theme}.png`) });
    }
    await ctx.close();
  }
});
