import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * E-14: a Board link (/s/<token>) shows each item as a card with its name, when (Now, Next,
 * Later) and status, never a bare one-column table headed "Item"; the cards fill the column
 * on a phone; and the page says the link's end day once (in its header), light and dark.
 * fails_when = the "Item" header shows, a card lacks its when, a card at 390 is narrower
 * than the column, or the end day is said twice.
 */

const DOC = "/documents/example-labs-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';

async function openBoardLink(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto(`${DOC}?audience=board`);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption({ label: "Board" });
  await sheet.getByLabel("Label").fill("Board, spring meeting");
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  const holder = await page.context().newPage();
  await holder.setViewportSize(page.viewportSize()!);
  await holder.goto(new URL(url).pathname);
  await holder.getByLabel("Passcode").fill(code);
  await holder.getByRole("button", { name: "Open" }).click();
  await expect(holder.frameLocator(FRAME).getByText(/^Shared with you/)).toBeVisible();
  return holder;
}

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${width} · ${scheme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: scheme });

      test("a Board link shows its items as cards with when, and says the end day once", async ({ page }) => {
        const holder = await openBoardLink(page);
        const frame = holder.frameLocator(FRAME);
        // No bare "Item" header: each item is a card.
        await expect(frame.locator("th:visible")).toHaveCount(0);
        const card = frame.locator("tr").filter({ hasText: "Falcon alerts rework" });
        await expect(card).toHaveCount(1);
        await expect(card).toContainText("Now");
        await expect(frame.locator("tr").filter({ hasText: "Partner API beta" })).toContainText("Next");
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
