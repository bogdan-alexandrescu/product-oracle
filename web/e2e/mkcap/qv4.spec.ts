// MOCK-HOOK mk-qa4-review: QV4 frames (never merged).
import { test } from "@playwright/test";
import { go, login, ONLY, SIZE, snap } from "./snap";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
const R = "/documents/usage-alerts-roadmap";
const want = (n: string) => !ONLY.length || ONLY.some((o) => n.startsWith(o));

for (const qv of ["a", "b", "c"] as const) {
  test(`qv4-${qv}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(SIZE.d);
    await login(page);
    if (want(`qv4-${qv}-rest`) || want(`qv4-${qv}-open`) || want(`qv4-${qv}-result`) || want(`qv4-${qv}-share`)) {
      await go(page, `${R}/publish?qv4=${qv}&mkdates=1&mkpub=draft`);
      if (want(`qv4-${qv}-rest`)) await snap(page, `qv4-${qv}-rest`);
      if (qv === "a") {
        await page.getByRole("button", { name: /^Publish v1$/ }).first().click();
        await page.waitForTimeout(600);
        if (want("qv4-a-open")) await snap(page, "qv4-a-open");
        await page.getByRole("dialog").getByRole("button", { name: /Publish/ }).last().click();
        await page.waitForTimeout(1500);
        if (want("qv4-a-result")) await snap(page, "qv4-a-result");
        await page.getByRole("link", { name: /Share a link/ }).or(page.getByRole("button", { name: /Share a link/ })).first().click();
        await page.waitForTimeout(1500);
        if (want("qv4-a-share")) await snap(page, "qv4-a-share");
      }
    }
    if (qv !== "a") {
      await go(page, `${R}?qv4=${qv}&mkdates=1&mkpub=draft&open=1`);
      await snap(page, `qv4-${qv}-open`);
      if (qv === "b") {
        await page.getByRole("button", { name: "Approve v1" }).click();
        await page.waitForTimeout(1500);
        await snap(page, "qv4-b-mid");
        await page.getByRole("button", { name: "Publish v1 for sharing" }).click();
        await page.waitForTimeout(1500);
        await snap(page, "qv4-b-result");
      } else {
        await page.getByRole("dialog").getByLabel(/Label/).fill("Board, November meeting");
        await page.getByRole("button", { name: "Approve, publish and share v1" }).click();
        await page.waitForTimeout(2000);
        await snap(page, "qv4-c-result");
      }
    }
    if (want(`qv4-${qv}-blockers`)) {
      await page.setViewportSize(SIZE.w);
      await go(page, `${R}?qv4=${qv}&mkdates=0&mkpub=draft&open=1`);
      await snap(page, `qv4-${qv}-blockers-1512`);
    }
  });
}
