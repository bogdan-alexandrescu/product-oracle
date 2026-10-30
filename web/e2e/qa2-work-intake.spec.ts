import { expect, test, type Locator, type Page } from "./test";

import { BEFORE_DRAFTING } from "../lib/api/mock/intake";

import { login } from "./helpers";

/*
 * QA pass 2 on the brief page, /intakes/<id> (qa-onboarding-5, 28, 40; rirs-10, 25, 27, 28,
 * 29, 30, 31), driven through the UI on the mock: the "before-drafting" scenario's brief, and
 * a new brief in the "empty" scenario.
 */

const scenario = (page: Page, name: string) =>
  page.addInitScript((s) => {
    if (!localStorage.getItem("po-mock-scenario")) localStorage.setItem("po-mock-scenario", s);
    localStorage.setItem("po-interview-follow-up", "off");
  }, name);

async function openIntake(page: Page) {
  await scenario(page, "before-drafting");
  await login(page);
  await page.goto(`/intakes/${BEFORE_DRAFTING.intakeId}`);
  await expect(page.getByRole("heading", { level: 1, name: BEFORE_DRAFTING.title })).toBeAttached();
  await expect(page.getByTestId("intake-thread")).toBeVisible();
}

const inspector = (page: Page) => page.getByTestId("intake-inspector").filter({ visible: true });
const readLine = (page: Page) => page.getByTestId("intake-read");

/** The contrast of an element's text on the colour behind it (tinted layers composited). */
async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const fg = parse(getComputedStyle(node).color).slice(0, 3);
    const layers: number[][] = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const [r, g, b, a = 1] = parse(getComputedStyle(at).backgroundColor);
      if (r === undefined || a === 0) continue;
      layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    let bg = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  });
}

test("qa-onboarding-5: a new company with no approved baseline is offered only Build the baseline", async ({ page }) => {
  await scenario(page, "empty");
  await login(page);
  await page.goto("/documents/new?kind=prd");
  await expect(page.getByRole("heading", { level: 1, name: "New PRD" })).toBeVisible();
  await page.getByRole("textbox", { name: "Title" }).fill("Saved addresses at checkout");
  await page.getByRole("textbox", { name: "What problem does it solve?" }).fill("Returning buyers retype their address at every checkout.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/intakes\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Draft with Oracle" }).click();
  const sheet = page.getByRole("dialog", { name: "Draft with Oracle" });
  const none = sheet.getByTestId("draft-baseline-none");
  await expect(none).toContainText("Build the baseline ($7.00)");
  await expect(none).toContainText("No baseline exists yet");
  await expect(sheet.getByRole("radio")).toHaveCount(0);
  await expect(sheet).not.toContainText("Use the current baseline");
});

test("qa-onboarding-28: the day's read cap shows before the first read", async ({ page }) => {
  await openIntake(page);
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("3 analyses left today");
  await readLine(page).getByRole("button", { name: "Read the brief again" }).click();
  await expect(readLine(page).getByTestId("intake-read-count")).toHaveText("2 analyses left today");
});

test("qa-onboarding-40: on a phone the read line never splits its date", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIntake(page);
  const day = readLine(page).getByTestId("intake-read-day");
  await expect(day).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
  await expect(day).toHaveCSS("white-space", "nowrap");
});

test("rirs-10: the header and the inspector give one critical count, open and holding the draft", async ({ page }) => {
  await openIntake(page);
  await expect(page.getByTestId("draft-reason")).toHaveText("4 critical questions open, 1 holds the draft: answer it or record a decision");
  const stat = inspector(page).getByTestId("stat-critical");
  await expect(stat).toContainText("Critical open");
  await expect(stat).toContainText("4");
  await expect(inspector(page).getByTestId("ready-to-draft")).toContainText("1 critical question holds the draft");
  await expect(inspector(page).getByTestId("ready-to-draft")).not.toContainText("1 critical question open");
});

test("rirs-25: on a phone the PRDs back link is at least 24 px tall", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openIntake(page);
  const back = page.getByTestId("intake-back").filter({ visible: true });
  await expect(back).toHaveText("PRDs");
  expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(24);
});

test("rirs-27: the batch size buttons say what they do and which is on", async ({ page }) => {
  await openIntake(page);
  const next = page.getByTestId("next-questions");
  const five = next.getByRole("button", { name: "Ask 5 questions at a time" });
  await expect(five).toHaveAttribute("aria-pressed", "true");
  const three = next.getByRole("button", { name: "Ask 3 questions at a time" });
  await expect(three).toHaveAttribute("aria-pressed", "false");
  await three.click();
  await expect(three).toHaveAttribute("aria-pressed", "true");
  await expect(next.getByRole("button", { name: "Ask 10 questions at a time" })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`rirs-28: the day in an answer bubble reads at 4.5:1 or more (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openIntake(page);
    const bubble = page.getByTestId("answer").filter({ hasText: "Returning buyers on the web shop" });
    const time = bubble.locator("time");
    await expect(time).toHaveText("Oct 20");
    expect(await contrast(time)).toBeGreaterThanOrEqual(4.5);
    // As readable as the name beside it.
    const name = await bubble.locator("span.font-semibold").first().evaluate((el) => getComputedStyle(el).color);
    await expect(time).toHaveCSS("color", name);
  });
}

test("rirs-29: one Oracle read action, named plainly, and the read in plain words", async ({ page }) => {
  await openIntake(page);
  await expect(readLine(page)).toContainText("2 things Oracle assumed (private to you), ");
  await expect(readLine(page)).not.toContainText("inference");
  await expect(readLine(page).getByRole("button", { name: "Read the brief again" })).toBeVisible();
  const header = page.locator("header[data-page-header]").filter({ visible: true });
  await header.getByRole("button", { name: /^Actions for / }).click();
  await expect(page.getByRole("menuitem", { name: /^Re-analyse/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /^Rank the questions again/ })).toContainText("re-orders the questions not asked yet");
});

test("rirs-30: a brief that is gone says what may have happened and leads back to PRDs", async ({ page }) => {
  await scenario(page, "before-drafting");
  await login(page);
  await page.goto("/intakes/c5000000-0000-4000-8000-0000000000ff");
  const gone = page.getByTestId("intake-gone");
  await expect(gone).toContainText("drafted into a PRD, archived, or deleted");
  await expect(page.getByText("Intake not found")).toHaveCount(0);
  await gone.getByRole("link", { name: "Back to PRDs" }).click();
  await expect(page).toHaveURL(/\/documents$/);
});

test("rirs-31: each queued question's drop-down is labelled Who answers", async ({ page }) => {
  await openIntake(page);
  const first = page.getByTestId("next-questions").getByTestId("next-question").first();
  await expect(first.getByText("Who answers", { exact: true })).toBeVisible();
  await expect(first.getByRole("combobox", { name: /^Who answers/ })).toBeVisible();
});
