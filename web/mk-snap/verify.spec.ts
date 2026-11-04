import fs from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
const DIR = path.resolve(process.env.SNAP_OUT ?? path.resolve(__dirname, "../../mockups-out/mk-milestones"), "frames");
const OUT = process.env.VOUT!;
test("verify", async ({ browser }) => {
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith(".html"))) {
    const html = fs.readFileSync(`${DIR}/${f}`, "utf8");
    const [w, h] = html.match(/mockup-viewport" content="(\d+)x(\d+)"/)!.slice(1).map(Number);
    const phone = w < 500;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`file://${DIR}/${f}`);
    await page.waitForTimeout(400);
    const d = await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]);
    await page.screenshot({ path: `${OUT}/${f.replace(".html", ".png")}` });
    console.log(f, JSON.stringify(d));
    await ctx.close();
  }
});
