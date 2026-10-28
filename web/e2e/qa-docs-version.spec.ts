import { expect, test, type Locator, type Page } from "./test";

import { login, openTab, sectionStrip } from "./helpers";

// QA pass 1, docs lane: the version page /documents/<doc>/v/<n> (Saved carts v2, a PRD with a
// brief; the early shipping cost technical brief, v1 earlier and v2 latest), driven as a person.

const CARTS = "/documents/saved-carts/v/2";
const BRIEF_V1 = "/documents/checkout-redesign-early-shipping-cost-spec/v/1";
const BRIEF_V2 = "/documents/checkout-redesign-early-shipping-cost-spec/v/2";
const PHONE = { width: 390, height: 844 };

/** Errors in the console and uncaught ones (React's hydration error #418 among them). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = rgb(getComputedStyle(node).color);
    let bg = [255, 255, 255];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.9)) {
        bg = c;
        break;
      }
    }
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
}

const panel = (page: Page) => page.getByTestId("review-panel").filter({ visible: true });
const reviewBar = (page: Page) => page.getByTestId("review-bar").filter({ visible: true }).first();

async function openVersion(page: Page, url: string, email?: string) {
  await login(page, email);
  await page.goto(url);
  await expect(page.getByTestId("document-sections")).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-5: the technical brief's versions load with no console error", async ({ page }) => {
    const errors = collectErrors(page);
    await openVersion(page, BRIEF_V1);
    await expect(page.getByTestId("doc-header")).toContainText("Early shipping cost: technical brief");
    await page.goto(BRIEF_V2);
    await expect(page.getByTestId("document-sections")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("qa-docs-4: a failed report says so plainly with a Retry; the account detail is under Details", async ({ page }) => {
    await openVersion(page, CARTS);
    await openTab(page, "History");
    const reports = page.getByTestId("history-reports").filter({ visible: true }).getByTestId("reports-panel");
    const alert = reports.getByRole("alert");
    await expect(alert).toContainText("The reports could not be written. Try again.");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    const history = page.getByTestId("history").filter({ visible: true });
    const job = history.getByTestId("llm-job").filter({ hasText: "Reports" }).first();
    await expect(job.getByTestId("job-failed-plain")).toBeVisible();
    await expect(job.getByTestId("job-error")).toBeHidden();
    // Nothing visible in History names the Claude accounts.
    const visibleText = await history.evaluate((el) => (el as HTMLElement).innerText);
    expect(visibleText).not.toMatch(/Claude account/);
  });

  test("qa-docs-13: each review count says what it counts", async ({ page }) => {
    await openVersion(page, CARTS);
    await expect(panel(page).getByTestId("stat-reviewed")).toContainText("Reviewed, all sections");
    await expect(panel(page).getByTestId("stat-reviewed")).toContainText(/\d+\/20/);
    await expect(sectionStrip(page).getByTestId("review-progress")).toHaveText(/\d+ of 8 brief sections reviewed/);
    await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
    await expect(sectionStrip(page).getByTestId("review-progress")).toHaveText(/\d+ of 20 sections reviewed/);
  });

  test("qa-docs-47: each action once: the whole-draft comment in the Feedback tab, Brief / Full in the switch", async ({ page }) => {
    await openVersion(page, CARTS);
    await expect(page.getByRole("button", { name: "Comment on the whole draft" }).filter({ visible: true })).toHaveCount(1);
    await expect(panel(page).getByRole("button", { name: "Comment on the whole draft" })).toBeVisible();
    await expect(page.getByTestId("doc-general-feedback")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Show full document|Show brief/ })).toHaveCount(0);
    await expect(page.getByTestId("view-note")).toContainText("Brief: 8 of 20 sections");
  });

  test("qa-docs-50: the full document starts at its Introduction, not the title again", async ({ page }) => {
    await openVersion(page, CARTS);
    await page.getByRole("group", { name: "Document view" }).getByRole("button", { name: "Full" }).click();
    const first = sectionStrip(page).locator("a[data-outline-key]").first();
    await expect(first).toHaveText(/Introduction$/);
    await expect(first).not.toContainText("Saved carts PRD");
  });

  test("qa-docs-49: a filter with no match says so and clears; feedback filters wait for feedback", async ({ page }) => {
    await openVersion(page, CARTS);
    await sectionStrip(page).getByTestId("outline-filter").fill("no section is called this");
    await expect(sectionStrip(page).getByTestId("outline-empty")).toContainText("No sections match");
    await sectionStrip(page).getByTestId("outline-clear-filter").click();
    await expect(sectionStrip(page).getByTestId("outline-filter")).toHaveValue("");
    await expect(sectionStrip(page).locator("a[data-outline-key]").first()).toBeVisible();

    // A state with nothing in it: the empty list offers Clear filter, back to the open feedback.
    const states = panel(page).getByTestId("feedback-state").getByRole("button");
    const texts = await states.allInnerTexts();
    const empty = texts.findIndex((t, i) => i > 0 && /\b0\s*$/.test(t.trim()));
    expect(empty).toBeGreaterThan(0);
    await states.nth(empty).click();
    await expect(panel(page).getByTestId("feedback-empty")).toContainText("Clear filter");
    await panel(page).getByTestId("feedback-clear-filter").click();
    await expect(states.first()).toHaveAttribute("aria-pressed", "true");

    // A version with no feedback at all shows no filters.
    await page.goto(BRIEF_V2);
    await expect(panel(page).getByTestId("feedback-empty")).toHaveText("No feedback yet");
    await expect(panel(page).getByTestId("feedback-state")).toHaveCount(0);
  });

  test("qa-docs-51: Request changes needs a note, and Save looks enabled once it can save", async ({ page }) => {
    await openVersion(page, CARTS);
    const bar = reviewBar(page);
    await bar.getByRole("button", { name: "Request changes" }).click();
    await expect(bar.getByText("What should change?")).toBeVisible();
    await expect(bar.getByText("(optional)")).toHaveCount(0);
    const save = bar.getByRole("button", { name: /^Save/ });
    await expect(save).toBeDisabled();
    await expect(bar.getByTestId("verdict-note-hint")).toBeVisible();
    await bar.getByRole("textbox").fill("Name the drop-off measure.");
    await expect(save).toBeEnabled();
    const [fill, accent] = await save.evaluate((el) => {
      const probe = document.createElement("span");
      probe.className = "bg-accent";
      document.body.append(probe);
      const a = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(el).backgroundColor, a];
    });
    expect(fill).toBe(accent);
  });

  test("qa-docs-52: Discuss says who can see it, and Oracle's reply follows the Ask Oracle box", async ({ page }) => {
    await openVersion(page, CARTS);
    await page.getByTestId("doc-discuss").click();
    const form = page.getByTestId("start-discussion").filter({ visible: true });
    const visible = form.getByRole("group", { name: "Visible to" });
    await expect(visible.getByRole("button", { name: "Everyone" })).toHaveAttribute("aria-pressed", "true");
    const ask = form.getByRole("checkbox", { name: "Ask Oracle" });
    // Alone in it, Oracle answers anyway: the box says so.
    await expect(ask).toBeChecked();
    await expect(ask).toBeDisabled();
    await expect(form.getByTestId("oracle-rule")).toHaveText("Oracle will reply");
    await visible.getByRole("button", { name: "Only people I pick" }).click();
    await form.getByRole("searchbox", { name: "Find a person" }).fill("approver");
    await form.getByRole("option", { name: /Approver/ }).click();
    await expect(ask).not.toBeChecked();
    await expect(ask).toBeEnabled();
    await expect(form.getByTestId("oracle-rule")).toHaveText("Oracle replies when you @mention it");
    await ask.check();
    await expect(form.getByTestId("oracle-rule")).toHaveText("Oracle will reply");
  });

  test("qa-docs-53: every export row lists its formats in the same order", async ({ page }) => {
    await openVersion(page, CARTS);
    await page.getByTestId("version-toolbar").getByRole("button", { name: "Export" }).click();
    const rows: string[][] = [];
    for (const name of ["Export full", "Export brief", "Export deck"]) {
      rows.push((await page.getByRole("group", { name }).getByRole("button").allInnerTexts()).map((t) => t.trim()));
    }
    expect(rows).toEqual([
      ["PDF", "HTML", "MD"],
      ["PDF", "HTML"],
      ["PDF", "PPTX"],
    ]);
  });

  test("qa-docs-66: an earlier spec version says so and does not push approval; Reconcile is a button", async ({ page }) => {
    await openVersion(page, BRIEF_V1, "approver@example.com");
    await expect(page.getByTestId("doc-header")).toContainText("Earlier version");
    await expect(page.getByText("You are viewing an earlier version.")).toBeVisible();
    await expect(page.getByTestId("approve-version")).toHaveAttribute("data-variant", "secondary");
    const reconcile = page.getByTestId("spec-staleness").filter({ visible: true }).getByRole("button", { name: "Reconcile" });
    await expect(reconcile).toHaveAttribute("data-variant", "secondary");
    await expect(reconcile).toHaveCSS("border-top-style", "solid");

    await page.goto(BRIEF_V2);
    await expect(page.getByTestId("approve-version")).toHaveAttribute("data-variant", "primary");
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`qa-docs-48: "Not reviewed" reads at 4.5:1 or better in ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    await openVersion(page, CARTS);
    const chip = page.getByTestId("verdict-none").filter({ visible: true }).first();
    await expect(chip).toHaveText("Not reviewed");
    expect(await contrast(chip)).toBeGreaterThanOrEqual(4.5);
  });
}

test.describe("phone", () => {
  test.use({ viewport: PHONE });

  test("qa-docs-12: one compact toolbar row, the rest behind More; Request changes keeps its words", async ({ page }) => {
    await openVersion(page, CARTS);
    const bar = page.getByTestId("version-toolbar");
    await expect(bar.getByRole("link", { name: "Impact" })).toHaveCount(0);
    const more = bar.getByTestId("version-more");
    await expect(more).toBeVisible();
    // The versions, the view and More: no ragged rows.
    expect((await bar.boundingBox())!.height).toBeLessThan(100);
    await more.click();
    const sheet = page.getByTestId("sheet-more");
    for (const name of ["Compare with v1", "Impact", "Present", "Quality"]) {
      await expect(sheet.getByRole("link", { name })).toBeVisible();
    }
    await sheet.getByRole("button", { name: /Close/ }).first().click();
    await expect(reviewBar(page).getByRole("button", { name: "Request changes" })).toHaveText("Request changes");
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  });

  test("qa-docs-68: the full document title shows on a phone, wrapped", async ({ page }) => {
    await openVersion(page, BRIEF_V1);
    const h1 = page.getByTestId("doc-header").getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toContainText("Early shipping cost: technical brief");
    const cut = await h1.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(cut).toBe(false);
  });

  test("qa-docs-5: no console error on a phone either", async ({ page }) => {
    const errors = collectErrors(page);
    await openVersion(page, BRIEF_V1);
    expect(errors).toEqual([]);
  });
});
