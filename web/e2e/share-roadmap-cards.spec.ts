import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * E-14: a Board link (/s/<token>) shows each item as a card with its name, when (its dates
 * as Simple reads them, month first: "Oct 5 – Nov 20" or "Dec 15", a tracker issue's date
 * included; nothing when it has none, never the Now, Next or Later its heading names) and
 * status (its delivery state as Simple computes it, whatever its horizon: an item in Next
 * with an issue in progress reads "In progress", an item in Now with none "Planned"; its
 * confidence beside it), never a bare one-column table headed "Item"; the cards fill the
 * column on a phone; and the page says the link's end day once (in its header), light and
 * dark. A Public link's page says it once too: its footer reads "Shared <day>" alone.
 * fails_when = the "Item" header shows, a card's status is its horizon's label, a card's
 * date is not its own (or an undated card repeats its horizon), a card at 390 is narrower
 * than the column, or the end day is said twice.
 */

const DOC = "/documents/example-labs-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';
// Each Board card of the "sharing" roadmap: its when and its status, exactly.
const CARDS: Record<string, [string, string]> = {
  // In Now, its own dates, no tracker issue: planned.
  "Falcon alerts rework": ["Oct 5 – Nov 20", "Planned"],
  // In Now, undated: nothing for when, not "Now".
  "Northwind bulk import": ["", "Planned"],
  // In Next, its tracker issue in progress and dated: in progress, by the issue's date.
  "Billing ledger v2": ["Jan 20", "In progress"],
  "Partner API beta": ["Dec 15", "Planned"],
};

async function openLink(page: Page, audience: "Board" | "Public", label: string) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  if (audience === "Public") {
    // The Public version is checked first, as an owner does: its draft text approved, then the check.
    await page.goto(`${DOC}/public`);
    const row = page.getByTestId("public-row").filter({ hasText: "Northwind bulk import" });
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByLabel("Public title").fill("Bulk import");
    await row.getByLabel("Public description").fill("Bring in many records at once from a spreadsheet.");
    await row.getByLabel("Stage").selectOption("planned");
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row.getByTestId("public-state")).toHaveText("Approved");
    await page.getByRole("button", { name: "Mark as checked" }).click();
    await expect(page.getByTestId("public-check")).toContainText("Checked by");
  }
  await page.goto(audience === "Board" ? `${DOC}?audience=board` : DOC);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption({ label: audience });
  await sheet.getByLabel("Label").fill(label);
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  const holder = await page.context().newPage();
  await holder.setViewportSize(page.viewportSize()!);
  await holder.goto(new URL(url).pathname);
  await holder.getByLabel("Passcode").fill(code);
  await holder.getByRole("button", { name: "Open" }).click();
  return holder;
}

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${width} · ${scheme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: scheme });

      test("a Board link shows its items as cards with a date and a status, and says the end day once", async ({ page }) => {
        const holder = await openLink(page, "Board", "Board, spring meeting");
        const frame = holder.frameLocator(FRAME);
        await expect(frame.getByText(/^Shared with you/)).toBeVisible();
        // No bare "Item" header: each item is a card.
        await expect(frame.locator("th:visible")).toHaveCount(0);
        // Every card says when (its own date, else nothing) and its delivery state.
        const cards = frame.locator(".section-wide tbody tr");
        await expect(cards.first()).toBeVisible();
        await expect(cards).toHaveCount(Object.keys(CARDS).length);
        for (const [name, [when, status]] of Object.entries(CARDS)) {
          // What the card says, line by line (an empty cell shows nothing).
          const said = (await cards.filter({ hasText: name }).locator("td").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
          expect(said.slice(0, when ? 3 : 2)).toEqual([name, ...(when ? [when] : []), status]);
        }
        const card = cards.filter({ hasText: "Falcon alerts rework" });
        await expect(card).toContainText("High confidence");
        await expect(cards.filter({ hasText: "Northwind bulk import" })).not.toContainText(/\b(?:Now|Next|Later)\b/);
        // A card is drawn as a card: its own border and rounded corners.
        const look = await card.evaluate((el) => {
          const s = getComputedStyle(el);
          return { display: s.display, radius: parseFloat(s.borderTopLeftRadius), border: parseFloat(s.borderTopWidth) };
        });
        expect(look.display).not.toBe("table-row");
        expect(look.radius).toBeGreaterThan(0);
        expect(look.border).toBeGreaterThan(0);
        // The card fills its column (a phone included), not just its words.
        const box = await card.boundingBox();
        const body = await holder.getByTestId("shared-body").boundingBox();
        if (width === 390) expect(box!.width).toBeGreaterThan(body!.width - 60);
        // The end day once: the header says it, the page's footer does not.
        const about = await holder.getByTestId("shared-about").innerText();
        const ends = about.match(/Link ends ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1];
        expect(ends).toBeTruthy();
        const footer = (await frame.locator(".share-footer").innerText()).trim();
        expect(footer).not.toContain(ends!);
        expect(footer).not.toMatch(/expires/);
      });
    });
  }
}

test("a Public link's page says the end day once: its footer says only when it was shared", async ({ page }) => {
  const holder = await openLink(page, "Public", "Customers, autumn");
  const frame = holder.frameLocator(FRAME);
  await expect(frame.getByRole("heading", { name: "Example Co roadmap" })).toBeVisible();
  const about = await holder.getByTestId("shared-about").innerText();
  const ends = about.match(/Link ends ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1];
  expect(ends).toBeTruthy();
  await expect(frame.getByText(/^Shared [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
  const text = await frame.locator("body").innerText();
  expect(text).not.toContain(ends!);
  expect(text).not.toMatch(/expires/);
});
