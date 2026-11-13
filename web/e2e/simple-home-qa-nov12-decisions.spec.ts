import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Visual QA, Nov 12, 2026 (docs/qa/2026-11-12/simple-home.md), Simple's Decisions page on the
 * mock's invented data: #7 the New decision sheet's fields sit inside its edges, #14 the
 * approvals note is one short line to Simple's Inbox with the why behind an (i), #15 where the
 * questions were read is not beside the Waiting for you count, #16 on a phone the title's (i)
 * shares the filters' row.
 */

async function decisions(page: Page) {
  await login(page);
  await page.goto("/simple/decisions");
  await expect(page.getByRole("region", { name: "Waiting for you", exact: true })).toBeVisible();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** #7: fails when the fields start left of the sheet's heading or their focus ring meets the window's edge. */
  test("#7 New decision: the fields sit inside the sheet, in line with its heading", async ({ page }) => {
    await decisions(page);
    await page.getByTestId("decisions-new").click();
    const sheet = page.getByTestId("decision-sheet");
    const heading = sheet.getByRole("heading", { name: "New decision" });
    await expect(heading).toBeVisible();
    const title = sheet.getByRole("textbox", { name: "Title", exact: true });
    await title.focus();
    await expect(title).toBeFocused();
    const head = (await heading.boundingBox())!;
    const box = (await title.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(head.x - 0.5);
    // The 2 px focus ring and a margin stay inside the window.
    expect(box.x + box.width + 2).toBeLessThanOrEqual(1440 - 8);
    for (const name of ["Question", "Context"]) {
      const b = (await sheet.getByRole("textbox", { name, exact: true }).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(head.x - 0.5);
    }
  });

  /** #14: fails when the note is the long prose or sends a person to Detailed's Inbox. */
  test("#14 the approvals note is short, opens Simple's Inbox, the why behind its (i)", async ({ page }) => {
    await decisions(page);
    const note = page.getByTestId("decisions-approvals");
    const link = note.getByRole("link", { name: "1 approval waits in your Inbox", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/simple/inbox");
    await expect(note.getByText(/not product decisions/)).toBeHidden();
    await expect(note.getByText(/in Detailed/)).toHaveCount(0);
    await note.getByTestId("decisions-approvals-info").click();
    await expect(note.getByRole("tooltip")).toBeVisible();
    await expect(note.getByRole("tooltip")).toContainText("not product decisions");
  });

  /** #15: fails when the source line sits on the count's row, as if it named what the count counts. */
  test("#15 where the questions were read sits after the rows, not beside the count", async ({ page }) => {
    await decisions(page);
    const mine = page.getByRole("region", { name: "Waiting for you", exact: true });
    const count = mine.getByTestId("questions-mine-count");
    const source = mine.getByTestId("questions-source");
    await expect(count).toBeVisible();
    await expect(source).toHaveText(/^Questions from /);
    const c = (await count.boundingBox())!;
    const s = (await source.boundingBox())!;
    expect(s.y).toBeGreaterThanOrEqual(c.y + c.height);
    const last = (await mine.getByTestId("question-row").filter({ visible: true }).last().boundingBox())!;
    expect(s.y).toBeGreaterThanOrEqual(last.y + last.height - 0.5);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** #16: fails when the title's (i) is alone on a row above the filters. */
  test("#16 on a phone the page's (i) shares the filters' row", async ({ page }) => {
    await decisions(page);
    const info = page.getByTestId("page-info").filter({ visible: true });
    await expect(info).toHaveCount(1);
    const i = (await info.boundingBox())!;
    const mid = i.y + i.height / 2;
    const boxes = await Promise.all((await page.getByRole("group", { name: "Filters" }).getByRole("combobox").all()).map((b) => b.boundingBox()));
    expect(boxes.length).toBe(3);
    expect(boxes.some((b) => !!b && mid >= b.y && mid <= b.y + b.height)).toBe(true);
    // Still opens the page's explanation.
    await info.click();
    await expect(page.getByText("What waits for you, soonest first. Then every decision, beside the meeting that took it.")).toBeVisible();
  });
});
