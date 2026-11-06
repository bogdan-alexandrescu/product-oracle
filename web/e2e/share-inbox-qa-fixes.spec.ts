import { login } from "./helpers";
import { expect, test, type Page } from "./test";

/**
 * Pre-demo visual QA, train AR:
 * - G-3: a shared roadmap (/s/<token>) reads each goal by its name and each tracker issue (an item's or a
 *   dependency's) by its title, its code beside it; never "Serves G1.", "ENG-512 tracks it" or a bare key.
 * - G-5: Inbox (Detailed): every row's Open is the same bordered button (a Comment's too), and a long title
 *   wraps to two lines rather than being cut.
 * - G-6: Inbox (Detailed) > Sources that need attention: each source's action is its problem's (Reconnect opens
 *   Settings › Connections for its account; Share again and Pick fewer channels open the source), the sentence
 *   behind an (i).
 * fails_when = a code shows without its name, an Open is drawn as text, a title is cut on one line, or a
 * source that must reconnect offers only Edit.
 */

const DOC = "/documents/example-labs-roadmap";
const FRAME = 'iframe[title="Shared roadmap"]';

async function openTeamLink(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
  await page.goto(DOC);
  await page.getByRole("button", { name: "Share a link", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Audience").selectOption({ label: "Team" });
  await sheet.getByLabel("Label").fill("Team, demo week");
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

for (const scheme of ["light", "dark"] as const) {
  test.describe(`1440 · ${scheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });

    test("G-3: a shared roadmap names each goal and tracker issue beside its code", async ({ page }) => {
      const holder = await openTeamLink(page);
      const frame = holder.frameLocator(FRAME);
      await expect(frame.getByText(/^Shared with you/)).toBeVisible();
      const body = frame.locator("body");
      await expect(body).toContainText("Serves Cut monthly churn to 2% (G1).");
      await expect(body).toContainText("Alert rules engine (ENG-512) tracks it.");
      await expect(body).toContainText("Partner sign-in tokens (ENG-530)");
      const text = await body.innerText();
      expect(text).not.toMatch(/Serves G\d/);
      expect(text).not.toMatch(/(^|[^(\w])ENG-\d+(?!\))/m);
    });

    test("G-5: every Inbox row's Open is one bordered button, and a long title wraps", async ({ page }) => {
      await login(page);
      await page.goto("/inbox");
      await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
      const needs = page.getByTestId("inbox-needs");
      const comment = needs.locator("tr[data-row]").filter({ hasText: "Comment" }).first();
      await expect(comment.getByRole("link", { name: /^Open/ })).toHaveAttribute("data-variant", "secondary");
      const opens = needs.getByRole("link", { name: /^Open/ });
      await expect(opens.first()).toBeVisible();
      for (const variant of await opens.evaluateAll((els) => els.map((e) => e.getAttribute("data-variant")))) expect(variant).toBe("secondary");
      // A title cut with "…" on one line would read nowrap: each wraps to (at most) two lines.
      const titles = needs.locator(`tr[data-row] td[data-phone="title"] .truncate`);
      await expect(titles.first()).toBeVisible();
      const styles = await titles.evaluateAll((els) => els.map((e) => [getComputedStyle(e).whiteSpace, getComputedStyle(e).webkitLineClamp]));
      for (const [space, clamp] of styles) {
        expect(space).not.toBe("nowrap");
        expect(clamp).toBe("2");
      }
    });

    test("G-6: a source that needs attention offers its problem's action, the sentence behind an (i)", async ({ page }) => {
      await login(page);
      await page.goto("/inbox");
      const group = page.getByTestId("inbox-sources");
      const drive = group.getByRole("row").filter({ hasText: "Drive folders" });
      await expect(drive.getByTestId("source-need-text")).toHaveText("Reconnect to choose files");
      await expect(drive.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
      await drive.getByRole("button", { name: "About Reconnect to choose files" }).click();
      await expect(page.getByText("Reconnect its account in Settings › Connections", { exact: false })).toBeVisible();
      const docs = group.getByRole("row").filter({ hasText: "Product docs" });
      await expect(docs.getByTestId("source-need-text")).toHaveText("Lost access to 2 items");
      await expect(docs.getByRole("link", { name: "Share again in Product docs" })).toHaveAttribute("href", /\/settings\/sources#source-/);
      const legacy = group.getByRole("row").filter({ hasText: "Legacy all-hands chat" });
      await expect(legacy.getByRole("link", { name: "Pick fewer channels in Legacy all-hands chat" })).toHaveAttribute("href", /\/settings\/sources#source-/);

      await drive.getByRole("link", { name: "Reconnect Drive folders" }).click();
      await expect(page).toHaveURL(/\/settings\/connections\?connection=/);
      await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    });
  });
}
