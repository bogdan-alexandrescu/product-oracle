// MOCK-HOOK mk-qa4-review: QV1 and QV3 frames (never merged).
import { type Page, test } from "@playwright/test"; // MOCK-HOOK
import { go, login, ONLY, SIZE, snap } from "./snap"; // MOCK-HOOK
// MOCK-HOOK
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } }); // MOCK-HOOK
const P = "/simple/prds/guided-setup"; // MOCK-HOOK
const want = (n: string) => !ONLY.length || ONLY.includes(n); // MOCK-HOOK
const shot = async (page: Page, n: string) => { if (want(n)) await snap(page, n); }; // MOCK-HOOK
const pick = async (page: Page, names: string[]) => { // MOCK-HOOK
  for (const n of names) { // MOCK-HOOK
    await page.getByRole("button", { name: "+ Add a reviewer" }).click(); // MOCK-HOOK
    await page.getByRole("button", { name: new RegExp(`^${n}`) }).click(); // MOCK-HOOK
  } // MOCK-HOOK
}; // MOCK-HOOK
// MOCK-HOOK
test("qv1-a", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(240_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  await go(page, `${P}?qv1=a&mkdraft=working`); // MOCK-HOOK
  await shot(page, "qv1-a-rest"); // MOCK-HOOK
  await page.getByRole("button", { name: "Send for approval…" }).click(); // MOCK-HOOK
  await shot(page, "qv1-a-open"); // MOCK-HOOK
  await page.getByRole("button", { name: "+ Add a reviewer" }).click(); // MOCK-HOOK
  await shot(page, "qv1-a-mid"); // MOCK-HOOK
  await page.getByRole("button", { name: /^Lee Park/ }).click(); // MOCK-HOOK
  await shot(page, "qv1-a-picked"); // MOCK-HOOK
  await page.getByRole("dialog").getByRole("button", { name: "Send for approval" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv1-a-result"); // MOCK-HOOK
  await page.setViewportSize(SIZE.w); // MOCK-HOOK
  await go(page, `${P}?qv1=a&mkdraft=working&open=1`); // MOCK-HOOK
  await pick(page, ["Lee Park", "Mina Shah", "Tom Becker", "Ana Lima"]); // MOCK-HOOK
  await page.getByRole("dialog").getByRole("button", { name: "Send for approval" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv1-a-many-1512"); // MOCK-HOOK
  await page.setViewportSize(SIZE.p); // MOCK-HOOK
  await go(page, `${P}?qv1=a&mkdraft=working&open=1`); // MOCK-HOOK
  await shot(page, "qv1-a-open-390"); // MOCK-HOOK
  await pick(page, ["Lee Park"]); // MOCK-HOOK
  await page.getByRole("dialog").getByRole("button", { name: "Send for approval" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv1-a-result-390"); // MOCK-HOOK
}); // MOCK-HOOK
// MOCK-HOOK
test("qv1-b", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(240_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  await go(page, `${P}?qv1=b&mkdraft=working`); // MOCK-HOOK
  await shot(page, "qv1-b-rest"); // MOCK-HOOK
  await go(page, `${P}?qv1=b&mkdraft=working&open=1`); // MOCK-HOOK
  await shot(page, "qv1-b-open"); // MOCK-HOOK
  await page.getByRole("menuitem", { name: /Ask for approval/ }).or(page.getByRole("button", { name: /^Ask for approval/ })).first().click(); // MOCK-HOOK
  await pick(page, ["Lee Park"]); // MOCK-HOOK
  await shot(page, "qv1-b-mid"); // MOCK-HOOK
  await page.getByRole("button", { name: "Send", exact: true }).click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv1-b-result"); // MOCK-HOOK
  await page.setViewportSize(SIZE.w); // MOCK-HOOK
  await go(page, `${P}?qv1=b&mkdraft=working&open=1`); // MOCK-HOOK
  await page.getByRole("menuitem", { name: /Ask for approval/ }).or(page.getByRole("button", { name: /^Ask for approval/ })).first().click(); // MOCK-HOOK
  await pick(page, ["Lee Park", "Mina Shah", "Tom Becker", "Ana Lima"]); // MOCK-HOOK
  await shot(page, "qv1-b-many-1512"); // MOCK-HOOK
  await page.setViewportSize(SIZE.p); // MOCK-HOOK
  await go(page, `${P}?qv1=b&mkdraft=working&open=1`); // MOCK-HOOK
  await shot(page, "qv1-b-open-390"); // MOCK-HOOK
}); // MOCK-HOOK
// MOCK-HOOK
test("qv1-c", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(240_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  await go(page, `${P}?qv1=c&mkdraft=working`); // MOCK-HOOK
  await shot(page, "qv1-c-rest"); // MOCK-HOOK
  await page.setViewportSize(SIZE.w); // MOCK-HOOK
  await go(page, `${P}?qv1=c&mkdraft=working`); // MOCK-HOOK
  await page.getByRole("button", { name: "Send edits for approval" }).click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv1-c-result-1512"); // MOCK-HOOK
  await page.setViewportSize(SIZE.p); // MOCK-HOOK
  await go(page, `${P}?qv1=c&mkdraft=working`); // MOCK-HOOK
  await shot(page, "qv1-c-rest-390"); // MOCK-HOOK
}); // MOCK-HOOK
// MOCK-HOOK
test("qv3-a", async ({ page }) => { // MOCK-HOOK
  test.setTimeout(240_000); // MOCK-HOOK
  await page.setViewportSize(SIZE.d); // MOCK-HOOK
  await login(page); // MOCK-HOOK
  await go(page, `${P}?qv3=a&mkdraft=working`); // MOCK-HOOK
  await shot(page, "qv3-a-rest"); // MOCK-HOOK
  await go(page, `${P}?qv3=a&mkdraft=working&open=1`); // MOCK-HOOK
  await shot(page, "qv3-a-open"); // MOCK-HOOK
  await page.getByRole("menuitem", { name: /Working draft/ }).or(page.getByRole("button", { name: /Working draft/ })).first().click(); // MOCK-HOOK
  await page.waitForTimeout(1200); // MOCK-HOOK
  await shot(page, "qv3-a-result"); // MOCK-HOOK
  await page.setViewportSize(SIZE.w); // MOCK-HOOK
  await go(page, `${P}?qv3=a&mkdraft=working&present=1&show=published`); // MOCK-HOOK
  await shot(page, "qv3-a-published-1512"); // MOCK-HOOK
  await page.setViewportSize(SIZE.p); // MOCK-HOOK
  await go(page, `${P}?qv3=a&mkdraft=working&open=1`); // MOCK-HOOK
  await shot(page, "qv3-a-open-390"); // MOCK-HOOK
}); // MOCK-HOOK
// MOCK-HOOK
for (const qv of ["b", "c"]) { // MOCK-HOOK
  test(`qv3-${qv}`, async ({ page }) => { // MOCK-HOOK
    test.setTimeout(240_000); // MOCK-HOOK
    await page.setViewportSize(SIZE.d); // MOCK-HOOK
    await login(page); // MOCK-HOOK
    await go(page, `${P}?qv3=${qv}&mkdraft=working${qv === "c" ? "&mkprop=1" : ""}&present=1`); // MOCK-HOOK
    await shot(page, `qv3-${qv}-result`); // MOCK-HOOK
    await page.setViewportSize(SIZE.w); // MOCK-HOOK
    await go(page, `${P}?qv3=${qv}&mkdraft=working${qv === "c" ? "&mkprop=1" : ""}&present=1`); // MOCK-HOOK
    const target = page.getByText(qv === "b" ? "A mobile setup flow" : /calendar access/i).first(); // MOCK-HOOK
    await target.evaluate((n) => n.scrollIntoView({ block: "center" })); // MOCK-HOOK
    await page.waitForTimeout(400); // MOCK-HOOK
    await shot(page, `qv3-${qv}-result-1512`); // MOCK-HOOK
  }); // MOCK-HOOK
} // MOCK-HOOK
