import { expect, mockNow, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * QA pass 2 on Company › Strategy and Company › Updates, and the shell pieces seen from them
 * (the Company tab strip, the phone tab bar, the mode switch), on the default mock scenario:
 * no vision or product strategy, no open drift findings, and the two seeded updates
 * ("Investor update · September 2026" approved, "Board update · October 2026" in review),
 * seen by owners and approvers. Each test names the finding it protects, and drives the UI
 * as a person would.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const strategyPage = (page: Page) => page.getByTestId("strategy-page").filter({ visible: true });
const nav = (page: Page) => page.getByRole("navigation", { name: "Company" }).filter({ visible: true });

async function openTab(page: Page, key: "strategy" | "decisions" | "rituals" | "updates" | "metrics" | "market") {
  await page.goto("/company/strategy");
  await expect(nav(page).getByTestId("company-tab-strategy")).toHaveAttribute("aria-current", "page");
  if (key === "strategy") return;
  await nav(page).getByTestId(`company-tab-${key}`).click();
  await expect(page).toHaveURL(new RegExp(`/company/${key}$`));
  await expect(nav(page).getByTestId(`company-tab-${key}`)).toHaveAttribute("aria-current", "page");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("qa-company-12, -14: New vision is a centred dialog that asks what Oracle should know, and asks before dropping typed work", async ({ page }) => {
    await login(page);
    await openTab(page, "strategy");
    await strategyPage(page).getByTestId("vision-card").getByRole("button", { name: "New vision" }).click();
    const dialog = page.getByRole("dialog", { name: "New vision" });
    await expect(dialog).toBeVisible();
    // A first vision has no last one to compare with.
    await expect(dialog.getByText("What changed since the last one")).toHaveCount(0);
    await dialog.getByLabel("Anything Oracle should know").fill("We are moving into mid-size teams.");
    // Centred like Propose decision, Add metric and New update, not a full-width bottom sheet.
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThan(800);
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(10);
    // Escape asks first: the typed note is not thrown away silently.
    await page.keyboard.press("Escape");
    await expect(dialog.getByTestId("dialog-discard")).toContainText("Discard your changes?");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog.getByLabel("Anything Oracle should know")).toHaveValue("We are moving into mid-size teams.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("qa-company-13: an empty stack says where the confirmed goals go and starts a product strategy; Drift says what it checks", async ({ page }) => {
    await login(page);
    await openTab(page, "strategy");
    const empty = strategyPage(page).getByTestId("stack-empty");
    await expect(empty).toContainText("confirmed goal");
    await expect(empty).toContainText("once a product strategy is approved");
    await expect(page.getByText("Nothing in the stack yet")).toHaveCount(0);
    const drift = strategyPage(page).getByTestId("drift-list");
    await expect(drift.getByTestId("drift-empty")).toContainText("No open findings");
    await expect(drift.getByTestId("drift-what")).toContainText("Oracle checks every day that each goal follows from the product strategy");

    await strategyPage(page).getByTestId("strategy-card").getByRole("button", { name: "New product strategy" }).click();
    const dialog = page.getByRole("dialog", { name: "New product strategy" });
    await expect(dialog.getByLabel("Anything Oracle should know")).toBeVisible();
    await expect(dialog.getByText("What changed since the last one")).toHaveCount(0);
  });

  test("qa-company-15, -16, -41: titles look like links, one Share button instead of a ⋯ menu, a flat visibility chip", async ({ page }) => {
    await login(page);
    await openTab(page, "updates");
    const row = page.getByTestId("update-row").filter({ hasText: "Board update · October 2026" });
    const link = row.getByRole("link", { name: "Board update · October 2026" });
    const h1 = page.getByRole("heading", { level: 1 }).filter({ visible: true }).first();
    const color = await link.evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe(await h1.evaluate((el) => getComputedStyle(el).color));
    await link.hover();
    await expect(link).toHaveCSS("text-decoration-line", "underline");

    // The visibility chip is never the state chip's blue fill, and flat, not outlined like a button (qa-company-37).
    const visibility = row.getByTestId("update-visibility").locator(":scope > *");
    await expect(visibility).toHaveText("Owners and approvers");
    await expect(visibility).toHaveAttribute("data-kind", "na");
    await expect(visibility).toHaveCSS("border-top-width", "0px");

    // One action: a labelled button, no menu.
    await expect(row.locator('[aria-haspopup="menu"]')).toHaveCount(0);
    const share = row.getByRole("button", { name: "Share Board update · October 2026 with the whole company" });
    await expect(share).toHaveText("Share with company…");
    await share.click();
    await expect(page.getByRole("dialog", { name: "Share with the whole company" })).toBeVisible();
  });

  test("qa-company-18: Draft with Oracle shows what the draft costs before it starts", async ({ page }) => {
    await login(page);
    await openTab(page, "updates");
    await page.getByRole("button", { name: "New update" }).click();
    const dialog = page.getByRole("dialog", { name: "New update" });
    await expect(dialog.getByTestId("update-cost")).toContainText("one Oracle run of about $4.50");
    await expect(dialog.getByRole("button", { name: "Draft with Oracle · $4.50" })).toBeVisible();
    // A board update drafts at standard depth: it costs more, and the dialog says so.
    await dialog.getByRole("radio", { name: /Board update/ }).check();
    await expect(dialog.getByTestId("update-cost")).toContainText("$9.00");
    await expect(dialog.getByRole("button", { name: "Draft with Oracle · $9.00" })).toBeVisible();
  });

  test("qa-company-17: a new update's draft has the update's own title on Home and in the Inbox", async ({ page }) => {
    await login(page);
    await openTab(page, "updates");
    await page.getByRole("button", { name: "New update" }).click();
    const dialog = page.getByRole("dialog", { name: "New update" });
    const now = mockNow();
    const title = `Investor update · ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
    await expect(dialog.getByLabel("Title")).toHaveValue(title);
    await dialog.getByRole("button", { name: /^Draft with Oracle/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const slugWords = `Investor update ${MONTHS[now.getMonth()].toLowerCase()} ${now.getFullYear()}`;

    await page.getByTestId("app-nav").getByTestId("nav-home").click();
    const flights = page.getByTestId("home-in-flight-table");
    await expect(flights).toContainText(title);
    await expect(flights).not.toContainText(slugWords);

    await page.getByTestId("app-nav").getByTestId("nav-inbox").click();
    await expect(page).toHaveURL(/\/inbox$/);
    const main = page.locator("main").first();
    await expect(main).toContainText(title);
    await expect(main).not.toContainText(slugWords);
  });

  test("qa-company-45: on a Detailed-only page the mode switch says so; on a page with a Simple match it does not", async ({ page }) => {
    await login(page);
    await openTab(page, "strategy");
    const rail = page.getByTestId("app-nav");
    await expect(rail.getByTestId("mode-switch")).toHaveAttribute("title", "This page is in Detailed only. Simple opens Simple's Home.");
    await expect(rail.getByTestId("mode-simple")).toHaveAttribute("title", /Detailed only/);
    await nav(page).getByTestId("company-tab-decisions").click();
    await expect(page).toHaveURL(/\/company\/decisions$/);
    await expect(rail.getByTestId("mode-switch")).not.toHaveAttribute("title", /.+/);
  });
});

test("qa-company-19: a commenter opening Updates is told who it is for, with the way back to Company", async ({ page }) => {
  await login(page, "commenter@example.com");
  await page.goto("/company/updates");
  const note = page.getByTestId("updates-not-found").filter({ visible: true });
  await expect(note).toContainText("Updates are for owners and approvers");
  await expect(page.getByText("Not found", { exact: true })).toHaveCount(0);
  await note.getByRole("link", { name: "Back to Company" }).click();
  await expect(page).toHaveURL(/\/company\/[a-z]+$/);
  await expect(page).not.toHaveURL(/\/company\/updates$/);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-company-33: the current Company tab is never under the strip's fade, and no sliver of the next tab shows", async ({ page }) => {
    await login(page);
    for (const key of ["updates", "rituals"] as const) {
      await page.goto(`/company/${key}`);
      const tab = nav(page).getByTestId(`company-tab-${key}`);
      await expect(tab).toHaveAttribute("aria-current", "page");
      // Let the strip settle (reveal, then the chevrons' width).
      await page.waitForTimeout(300);
      const out = await nav(page).evaluate((n) => {
        const strip = n.querySelector<HTMLElement>("[id]")!;
        // Each fade length as the mask reads it (a max() resolved by laying it out as a width).
        const px = (name: string) => {
          const probe = document.createElement("span");
          probe.style.cssText = `position:absolute;display:block;height:0;width:var(${name})`;
          strip.appendChild(probe);
          const w = probe.getBoundingClientRect().width;
          probe.remove();
          return w;
        };
        const r = strip.getBoundingClientRect();
        // The fully visible band: past the fades on either side.
        const solid = [r.left + px("--fade-l1"), r.right - px("--fade-r1")];
        // Anything at all visible: before the fully transparent edges.
        const seen = [r.left + px("--fade-l0"), r.right - px("--fade-r0")];
        const tabs = [...strip.querySelectorAll<HTMLElement>("a")].map((a) => {
          const b = a.getBoundingClientRect();
          return { current: a.getAttribute("aria-current") === "page", left: b.left, right: b.right };
        });
        return { solid, seen, tabs };
      });
      const current = out.tabs.find((t) => t.current)!;
      expect(current.left).toBeGreaterThanOrEqual(out.solid[0] - 0.5);
      expect(current.right).toBeLessThanOrEqual(out.solid[1] + 0.5);
      for (const t of out.tabs) {
        const shown = Math.max(0, Math.min(t.right, out.seen[1]) - Math.max(t.left, out.seen[0]));
        // A tab shows whole or not at all: no part of one beside the chevron.
        expect(shown === 0 || shown >= t.right - t.left - 1).toBe(true);
      }
    }
  });

  test("qa-company-37: the bottom bar's More, current on a Company page, has one indicator", async ({ page }) => {
    await login(page);
    await page.goto("/company/strategy");
    const more = page.getByTestId("tab-more");
    await expect(more).toHaveClass(/bg-rail-active/);
    const before = await more.evaluate((el) => getComputedStyle(el, "::before").content);
    expect(before).toBe("none");
  });
});
