// MOCK-HOOK mk-qa4-review: QV2 frames (never merged).
import { type Page, test } from "@playwright/test"; // MOCK-HOOK
import { go, login, ONLY, SIZE, snap } from "./snap"; // MOCK-HOOK
// MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK
const P = "/simple/prds/guided-setup"; // MOCK-HOOK
const S = "mkdraft=submitted&mkprop=1"; // MOCK-HOOK
const want = (n: string) => !ONLY.length || ONLY.includes(n); // MOCK-HOOK
const shot = async (page: Page, n: string) => { if (want(n)) await snap(page, n); }; // MOCK-HOOK
/** Scrolls the window so the element's top sits `gap` px under the top edge. */ // MOCK-HOOK
const topAt = async (page: Page, sel: ReturnType<Page["getByText"]>, gap: number) => { // MOCK-HOOK
  const y = await sel.first().evaluate((n) => n.getBoundingClientRect().top + window.scrollY); // MOCK-HOOK
  await page.evaluate((v) => window.scrollTo(0, v), Math.max(0, Math.round(y - gap))); // MOCK-HOOK
  await page.waitForTimeout(300); // MOCK-HOOK
}; // MOCK-HOOK
// MOCK-HOOK
test("qv2-viewer", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(300_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page, "viewer@example.com"); // MOCK-HOOK
  for (const qv of ["a", "b", "c"]) { // MOCK-HOOK
    await page.setViewportSize(SIZE.d); // MOCK-HOOK
    await go(page, `${P}?qv2=${qv}&${S}`); // MOCK-HOOK
    await shot(page, `qv2-${qv}-rest`); // MOCK-HOOK
    if (qv === "a") { // MOCK-HOOK
      await page.getByRole("button", { name: /^See the/ }).click(); // MOCK-HOOK
      await shot(page, "qv2-a-open"); // MOCK-HOOK
      await page.setViewportSize(SIZE.w); // MOCK-HOOK
      await go(page, `${P}?qv2=a&${S}&list=1`); // MOCK-HOOK
      await shot(page, "qv2-a-open-1512"); // MOCK-HOOK
      await page.setViewportSize(SIZE.p); // MOCK-HOOK
      await go(page, `${P}?qv2=a&${S}&list=1`); // MOCK-HOOK
      await shot(page, "qv2-a-open-390"); // MOCK-HOOK
    } // MOCK-HOOK
    if (qv === "b") { // MOCK-HOOK
      const mark = page.getByRole("button", { name: /Change in review · see it/ }).first(); // MOCK-HOOK
      await topAt(page, page.getByText("A setup checklist that shows the next step").or(page.getByText("WHAT WE WILL BUILD", { exact: false })), 220); // MOCK-HOOK
      await mark.click(); // MOCK-HOOK
      await topAt(page, page.getByText(/problem and who has it/i), 24); // MOCK-HOOK
      await shot(page, "qv2-b-open"); // MOCK-HOOK
      await page.setViewportSize(SIZE.w); // MOCK-HOOK
      await go(page, `${P}?qv2=b&${S}&list=1`); // MOCK-HOOK
      await topAt(page, page.getByText(/what we will build/i), 24); // MOCK-HOOK
      await shot(page, "qv2-b-open-1512"); // MOCK-HOOK
      await page.setViewportSize(SIZE.p); // MOCK-HOOK
      await go(page, `${P}?qv2=b&${S}&list=1`); // MOCK-HOOK
      await topAt(page, page.getByText(/what we will build/i), 24); // MOCK-HOOK
      await shot(page, "qv2-b-open-390"); // MOCK-HOOK
    } // MOCK-HOOK
    if (qv === "c") { // MOCK-HOOK
      await page.setViewportSize(SIZE.w); // MOCK-HOOK
      await go(page, `${P}?qv2=c&${S}`); // MOCK-HOOK
      await page.getByRole("button", { name: "Tell me when it is published" }).click(); // MOCK-HOOK
      await shot(page, "qv2-c-result-1512"); // MOCK-HOOK
      await page.setViewportSize(SIZE.p); // MOCK-HOOK
      await go(page, `${P}?qv2=c&${S}`); // MOCK-HOOK
      await shot(page, "qv2-c-rest-390"); // MOCK-HOOK
    } // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK
// MOCK-HOOK
test("qv2-overview", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(300_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page, "commenter@example.com"); // MOCK-HOOK
  for (const qv of ["a", "b", "c"]) { // MOCK-HOOK
    await go(page, `/documents/checkout-redesign?qv2=${qv}`); // MOCK-HOOK
    const anchor = qv === "b" ? page.getByTestId("asked-of-you") : page.getByText("Section owners and reviewers"); // MOCK-HOOK
    await topAt(page, anchor, 24); // MOCK-HOOK
    await shot(page, `qv2-${qv}-overview`); // MOCK-HOOK
    if (qv === "a") { // MOCK-HOOK
      await page.getByRole("link", { name: "Give feedback" }).first().click(); // MOCK-HOOK
      await page.waitForLoadState("networkidle"); // MOCK-HOOK
      await page.waitForTimeout(1200); // MOCK-HOOK
      await shot(page, "qv2-a-overview-result"); // MOCK-HOOK
    } // MOCK-HOOK
  } // MOCK-HOOK
}); // MOCK-HOOK
