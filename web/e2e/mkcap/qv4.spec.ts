// MOCK-HOOK mk-qa4-review: QV4 frames (never merged).
import { test } from "@playwright/test"; // MOCK-HOOK
import { go, login, ONLY, SIZE, snap } from "./snap"; // MOCK-HOOK
// MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK
const R = "/documents/usage-alerts-roadmap"; // MOCK-HOOK
const want = (n: string) => !ONLY.length || ONLY.some((o) => n.startsWith(o)); // MOCK-HOOK
// MOCK-HOOK
for (const qv of ["a", "b", "c"] as const) { // MOCK-HOOK
  test(`qv4-${qv}`, async ({ page }) => { // MOCK-HOOK
    test.setTimeout(180_000); // MOCK-HOOK
    await page.setViewportSize(SIZE.d); // MOCK-HOOK
    await login(page); // MOCK-HOOK
    if (want(`qv4-${qv}-rest`) || want(`qv4-${qv}-open`) || want(`qv4-${qv}-result`) || want(`qv4-${qv}-share`)) { // MOCK-HOOK
      await go(page, `${R}/publish?qv4=${qv}&mkdates=1&mkpub=draft`); // MOCK-HOOK
      if (want(`qv4-${qv}-rest`)) await snap(page, `qv4-${qv}-rest`); // MOCK-HOOK
      if (qv === "a") { // MOCK-HOOK
        await page.getByRole("button", { name: /^Publish v1$/ }).first().click(); // MOCK-HOOK
        await page.waitForTimeout(600); // MOCK-HOOK
        if (want("qv4-a-open")) await snap(page, "qv4-a-open"); // MOCK-HOOK
        await page.getByRole("dialog").getByRole("button", { name: /Publish/ }).last().click(); // MOCK-HOOK
        await page.waitForTimeout(1500); // MOCK-HOOK
        if (want("qv4-a-result")) await snap(page, "qv4-a-result"); // MOCK-HOOK
        await page.getByRole("link", { name: /Share a link/ }).or(page.getByRole("button", { name: /Share a link/ })).first().click(); // MOCK-HOOK
        await page.waitForTimeout(1500); // MOCK-HOOK
        if (want("qv4-a-share")) await snap(page, "qv4-a-share"); // MOCK-HOOK
      } // MOCK-HOOK
    } // MOCK-HOOK
    if (qv !== "a") { // MOCK-HOOK
      await go(page, `${R}?qv4=${qv}&mkdates=1&mkpub=draft&open=1`); // MOCK-HOOK
      await snap(page, `qv4-${qv}-open`); // MOCK-HOOK
      if (qv === "b") { // MOCK-HOOK
        await page.getByRole("button", { name: "Approve v1" }).click(); // MOCK-HOOK
        await page.waitForTimeout(1500); // MOCK-HOOK
        await snap(page, "qv4-b-mid"); // MOCK-HOOK
        await page.getByRole("button", { name: "Publish v1 for sharing" }).click(); // MOCK-HOOK
        await page.waitForTimeout(1500); // MOCK-HOOK
        await snap(page, "qv4-b-result"); // MOCK-HOOK
      } else { // MOCK-HOOK
        await page.getByRole("dialog").getByLabel(/Label/).fill("Board, November meeting"); // MOCK-HOOK
        await page.getByRole("button", { name: "Approve, publish and share v1" }).click(); // MOCK-HOOK
        await page.waitForTimeout(2000); // MOCK-HOOK
        await snap(page, "qv4-c-result"); // MOCK-HOOK
      } // MOCK-HOOK
    } // MOCK-HOOK
    if (want(`qv4-${qv}-blockers`)) { // MOCK-HOOK
      await page.setViewportSize(SIZE.w); // MOCK-HOOK
      await go(page, `${R}?qv4=${qv}&mkdates=0&mkpub=draft&open=1`); // MOCK-HOOK
      await snap(page, `qv4-${qv}-blockers-1512`); // MOCK-HOOK
    } // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK
