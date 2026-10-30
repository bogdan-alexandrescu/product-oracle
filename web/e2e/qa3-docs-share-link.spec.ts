import { expect, test, type Page } from "./test";

import { login } from "./helpers";

// QA pass 3, docs lane: the link holder's /s/<token> page (its passcode gate, header, frame and
// footer) and the in-app Audience view of a roadmap. The "sharing" scenario seeds the published
// Platform roadmap, autumn; Usage alerts roadmap is the one built from a PRD.

const DOC = "/documents/example-labs-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';

async function sharing(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
}

/** An owner makes a Board link with downloads on; returns its path and passcode. */
async function makeLink(page: Page) {
  await sharing(page);
  await page.goto(`${DOC}?audience=board`);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Label").fill("Board, November meeting");
  await sheet.getByLabel("Allow PDF download").check();
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  return { path: new URL(url).pathname, code };
}

/** Makes the link, then this tab opens it as its holder. */
async function openShared(page: Page) {
  const { path, code } = await makeLink(page);
  await page.goto(path);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator(FRAME).getByText(/^Shared with you/)).toBeVisible();
  return page.frameLocator(FRAME);
}

const bodyStyle = (page: Page, frame: string) =>
  page
    .frameLocator(frame)
    .locator("body")
    .evaluate((b) => {
      const s = getComputedStyle(b);
      return { bg: s.backgroundColor, color: s.color, font: s.fontFamily };
    });

async function darkPage(page: Page) {
  await page.emulateMedia({ colorScheme: "dark" });
  await openShared(page);
  const inside = await bodyStyle(page, FRAME);
  // Dark surfaces, light words: inside the frame and around it.
  expect(inside.bg).toBe("rgb(15, 23, 42)");
  expect(inside.color).toBe("rgb(226, 232, 240)");
  const outside = await page.getByTestId("shared-page").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(outside).toBe("rgb(15, 23, 42)");
  await expect(page.getByTestId("shared-header").getByRole("heading", { level: 1 })).toHaveCSS("color", "rgb(226, 232, 240)");
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("qa-docs-11: the shared roadmap is dark when the reader prefers dark", async ({ page }) => {
    await darkPage(page);
  });

  test("qa-docs-12: the shared roadmap shows no export labels or internal notes", async ({ page }) => {
    const frame = await openShared(page);
    const text = await frame.locator("body").innerText();
    expect(text).toContain("Platform roadmap, autumn");
    expect(text).toMatch(/As of [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(text).not.toContain("mock export");
    expect(text).not.toContain("Audience");
    expect(text).not.toContain("Approved ·");
    expect(text).not.toContain("left out");
    expect(text).not.toContain("serves no confirmed goal");
  });

  test("qa-docs-12: a Team link shows no item's no-goal flag, which the company's Team view keeps", async ({ page }) => {
    await sharing(page);
    await page.goto(`${DOC}?audience=team`);
    const own = page.frameLocator('iframe[title="Roadmap for Team"]');
    await expect(own.getByText("\u2691 Serves no confirmed goal.")).toBeVisible();
    await page.getByRole("button", { name: "Share a link", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Share roadmap" });
    await sheet.getByLabel("Label").fill("Team, November");
    await sheet.getByRole("button", { name: "Create link" }).click();
    const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
    const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
    await sheet.getByRole("button", { name: "Done" }).click();
    await page.goto(new URL(url).pathname);
    await page.getByLabel("Passcode").fill(code);
    await page.getByRole("button", { name: "Open" }).click();
    const frame = page.frameLocator(FRAME);
    await expect(frame.getByRole("heading", { name: "Ops console cleanup" })).toBeVisible();
    const text = await frame.locator("body").innerText();
    expect(text).toContain("Kept for the support team.");
    expect(text).not.toMatch(/serves no confirmed goal/i);
    expect(text).not.toContain("\u2691");
  });

  test("qa-docs-13: the shared tables have no empty column and no Goal column under the goal", async ({ page }) => {
    const frame = await openShared(page);
    const tables = frame.getByRole("table");
    await expect(tables.first()).toBeVisible();
    await expect(frame.getByRole("columnheader", { name: "Goal", exact: true })).toHaveCount(0);
    // Every column has at least one filled cell.
    const empty = await frame.locator("body").evaluate((b) =>
      [...b.querySelectorAll("table")].flatMap((t) => {
        const rows = [...t.querySelectorAll("tbody tr")];
        const heads = [...t.querySelectorAll("thead th")];
        return heads
          .map((h, n) => ({ name: h.textContent, filled: rows.some((r) => (r.children[n]?.textContent ?? "").trim()) }))
          .filter((c) => !c.filled)
          .map((c) => c.name);
      }),
    );
    expect(empty).toEqual([]);
    await expect(frame.getByRole("row").filter({ hasText: "Falcon alerts rework" })).toHaveCount(1);
  });

  test("qa-docs-14: the header and the footer give one end day, in the app's date format", async ({ page }) => {
    const frame = await openShared(page);
    const about = (await page.getByTestId("shared-about").innerText()).trim();
    const ends = about.match(/Link ends ([A-Z][a-z]{2} \d{1,2}, \d{4})$/)?.[1];
    expect(ends).toBeTruthy();
    const footer = (await frame.locator(".share-footer").innerText()).trim();
    expect(footer).toMatch(new RegExp(`link expires ${ends}$`));
    expect(footer).toMatch(/ on [A-Z][a-z]{2} \d{1,2}, \d{4} · /);
    expect(footer).not.toMatch(/\d{1,2} [A-Z][a-z]{2} \d{4}/);
  });

  test("qa-docs-15: the Audience view is styled, in the app's type, with real tables", async ({ page }) => {
    await sharing(page);
    await page.goto("/documents/usage-alerts-roadmap");
    const name = 'iframe[title="Roadmap for Team"]';
    const team = page.frameLocator(name);
    await expect(team.getByRole("columnheader", { name: "Horizon" })).toBeVisible();
    const text = await team.locator("body").innerText();
    expect(text).not.toContain("Horizon | Item");
    expect(text).not.toContain("mock export");
    const { font } = await bodyStyle(page, name);
    expect(font).toContain("system-ui");
    expect(font).not.toMatch(/Times/);
  });

  test("qa-docs-70: the shared page uses the app's type and Download PDF sits inset", async ({ page }) => {
    await openShared(page);
    const { font } = await bodyStyle(page, FRAME);
    expect(font).toContain("system-ui");
    expect(font).not.toMatch(/Times/);
    const box = await page.getByRole("button", { name: "Download PDF" }).boundingBox();
    expect(box).not.toBeNull();
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 24);
  });

  test("qa-docs-71: the passcode gate says a passcode is needed, and why Open is greyed", async ({ page }) => {
    const { path } = await makeLink(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Enter the passcode" })).toBeVisible();
    await expect(page.getByText("Someone shared a private roadmap with you. It opens with the passcode they gave you.")).toBeVisible();
    const open = page.getByRole("button", { name: "Open" });
    await expect(open).toBeDisabled();
    await expect(page.getByTestId("passcode-why")).toHaveText("Enter the passcode first");
    await expect(open).toHaveAccessibleDescription("Enter the passcode first");
    await page.getByLabel("Passcode").fill("anything");
    await expect(page.getByTestId("passcode-why")).toHaveCount(0);
    await expect(open).toBeEnabled();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("qa-docs-11 (phone): the shared roadmap is dark when the reader prefers dark", async ({ page }) => {
    await darkPage(page);
  });

  test("qa-docs-13 (phone): item names are not squeezed to a word a line; nothing scrolls sideways", async ({ page }) => {
    const frame = await openShared(page);
    const cell = frame.getByRole("row").filter({ hasText: "Falcon alerts rework" }).getByRole("cell").first();
    await expect(cell).toBeVisible();
    const lines = await cell.evaluate((td) => {
      const s = getComputedStyle(td);
      const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.5;
      return (td.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / line;
    });
    // "Falcon alerts rework" is three words: never one a line.
    expect(lines).toBeLessThan(2.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
