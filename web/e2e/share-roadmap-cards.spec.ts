import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * E-14: a Board link (/s/<token>) shows each item as a card with its name, when (its own
 * dates, month first: "Oct 5 – Nov 20" or "Dec 15"; Now, Next or Later only when it has
 * none) and status (its delivery state, which every item has, its confidence beside it),
 * never a bare one-column table headed "Item"; the cards fill the column on a phone; and the
 * page says the link's end day once (in its header), light and dark. A Public link's page
 * says it once too: its footer reads "Shared <day>" alone.
 * fails_when = the "Item" header shows, a card lacks its date or status, a dated card shows
 * only its horizon, a card at 390 is narrower than the column, or the end day is said twice.
 */

const DOC = "/documents/example-labs-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';
const DAY = "[A-Z][a-z]{2} \\d{1,2}(?:, \\d{4})?";
const WHEN = new RegExp(`^(?:Now|Next|Later|${DAY}(?: – ${DAY})?)$`);
const STATUS = /^(?:Shipped recently|Shipped|In progress|Planned|Exploring)$/;

async function openLink(page: Page, audience: "Board" | "Public", label: string) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  if (audience === "Public") {
    // The Public version is checked first (its two approved texts), as an owner does.
    await page.goto(`${DOC}/public`);
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
        // Every card says when (its date, or its horizon when it has none) and its status.
        const cards = frame.locator(".section-wide tr");
        await expect(cards.first()).toBeVisible();
        const count = await cards.count();
        expect(count).toBeGreaterThanOrEqual(4);
        for (let n = 0; n < count; n++) {
          const cells = cards.nth(n).locator("td");
          expect((await cells.nth(1).innerText()).trim()).toMatch(WHEN);
          expect((await cells.nth(2).innerText()).trim()).toMatch(STATUS);
        }
        const card = cards.filter({ hasText: "Falcon alerts rework" });
        await expect(card).toHaveCount(1);
        // Its own dates, not the Now heading above it; its delivery state; its confidence.
        await expect(card.locator("td").nth(1)).toHaveText("Oct 5 – Nov 20");
        await expect(card.locator("td").nth(2)).toHaveText("In progress");
        await expect(card).toContainText("High confidence");
        const partner = cards.filter({ hasText: "Partner API beta" });
        await expect(partner.locator("td").nth(1)).toHaveText("Dec 15");
        await expect(partner.locator("td").nth(2)).toHaveText("Planned");
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
