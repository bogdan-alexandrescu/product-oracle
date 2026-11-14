import { expect, test, type Page } from "./test";

import { login } from "./helpers";

/*
 * Outcomes (owner, Nov 13): after Move to Trash, the "Moved to Trash: … Undo" message never
 * covers the next open dialog's title or buttons, on a desktop (1440) and a phone (390), in
 * both themes. Mock API, "outcomes" scenario (synthetic: six earlier activation bets).
 *
 * Each test states its card: protects (the observable), fails_when (the wrong result it
 * rejects), no_claim (what green does not prove).
 */

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const inspector = (page: Page) => page.getByTestId("outcome-inspector").filter({ visible: true });

async function trash(page: Page, title: string) {
  await page.getByTestId("outcome-row").filter({ hasText: title }).click();
  await inspector(page).getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
}

for (const [name, viewport, phone] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`${name}, ${scheme}: the Moved to Trash message stays clear of the next delete dialog's title and buttons`, async ({ page }) => {
      // protects=with the message on screen, the next delete dialog's heading, Cancel and Move to
      // Trash are not under it; fails_when=the message sits over the dialog's title or buttons;
      // no_claim=the Undo itself (outcomes-trash.spec.ts).
      test.setTimeout(90_000);
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "outcomes"));
      await login(page);
      await page.goto("/plan/outcomes");
      await page.getByTestId("outcome-filters").getByRole("button", { name: /^All/ }).click();

      await trash(page, "Earlier activation bet 1");
      const dialog = page.getByTestId("delete-dialog");
      await dialog.getByRole("button", { name: "Move to Trash" }).click();
      await expect(dialog).toBeHidden();
      const message = page.getByTestId("toasts").getByRole("status");
      await expect(message).toContainText("Moved to Trash");

      // A phone's outcome sheet closes before the next row is picked.
      if (phone && (await page.getByTestId("outcome-sheet").isVisible())) await page.keyboard.press("Escape");
      await trash(page, "Earlier activation bet 2");
      await expect(dialog).toBeVisible();
      await expect(message).toBeVisible();
      // Let the message settle where it goes while the dialog is open.
      await page.waitForTimeout(500);
      const said = (await message.boundingBox())!;
      const parts = [
        dialog.getByRole("heading").first(),
        dialog.getByRole("button", { name: "Cancel" }),
        dialog.getByRole("button", { name: "Move to Trash" }),
      ];
      for (const part of parts) {
        const box = (await part.boundingBox())!;
        expect(overlap(said, box), `the message covers ${await part.textContent()}`).toBe(0);
      }
    });
  }
}
