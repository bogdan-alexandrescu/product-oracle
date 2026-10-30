import { expect, test, type Locator, type Page } from "./test";

import { MOCK_ROLE_KEY } from "../lib/api/mock/server";
import { login } from "./helpers";

// QA pass 2, docs lane: the link holder's /s/<token> page, a roadmap's Share links and the
// New PRD / New roadmap pages (/documents/new).

const DOC = "/documents/example-labs-roadmap";

async function sharing(page: Page) {
  await page.addInitScript(() => localStorage.setItem("po-mock-scenario", "sharing"));
  await login(page);
}

/** An owner shares a Board link with downloads on; this tab then opens it as the holder. */
async function openShared(page: Page) {
  await sharing(page);
  await page.goto(`${DOC}?audience=board`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Share roadmap" });
  await sheet.getByLabel("Label").fill("Board, November meeting");
  await sheet.getByLabel("Allow PDF download").check();
  await sheet.getByRole("button", { name: "Create link" }).click();
  const url = await sheet.getByLabel("Link", { exact: true }).inputValue();
  const code = await sheet.getByLabel("Passcode", { exact: true }).inputValue();
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.goto(new URL(url).pathname);
  await page.getByLabel("Passcode").fill(code);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.frameLocator('iframe[title="Shared roadmap"]').getByText("Audience Board", { exact: true })).toBeVisible();
}

async function openNew(page: Page, kind: "prd" | "roadmap") {
  await page.addInitScript(([rk, r]) => localStorage.setItem(rk, r), [MOCK_ROLE_KEY, "owner"] as const);
  await login(page);
  await page.goto(`/documents/new?kind=${kind}`);
}

/** Waits for every theme thumbnail to show its picture; returns them. */
async function thumbnails(page: Page) {
  const thumbs = page.getByRole("radiogroup", { name: "Theme" }).getByTestId("theme-thumbnail");
  await expect(thumbs.first()).toBeVisible();
  const n = await thumbs.count();
  for (let i = 0; i < n; i++) await expect(thumbs.nth(i)).toHaveAttribute("data-ready", "true");
  return { thumbs, n };
}

/** How many dark pixels (any channel under 150) a screenshot of the element holds: words and rules. */
async function ink(page: Page, el: Locator) {
  const png = (await el.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 150 || d[i + 1] < 150 || d[i + 2] < 150) dark++;
    return dark;
  }, png);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const scheme of ["light", "dark"] as const) {
    // qa-docs-1: the shared page is light whatever the app's theme; so is its Download PDF button.
    test(`qa-docs-1 (${scheme}): the shared page's Download PDF button is light with dark words`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShared(page);
      const button = page.getByRole("button", { name: "Download PDF" });
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(button).toHaveCSS("color", "rgb(15, 23, 42)");
    });
  }

  // qa-docs-26: the shared page's content keeps the header's side margins.
  test("qa-docs-26: the shared page's tables and rules stop short of the window's edges", async ({ page }) => {
    await openShared(page);
    const header = await page.getByTestId("shared-header").evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
    const edges = await page.getByTestId("shared-frame").evaluate((el: HTMLIFrameElement) => {
      const box = el.getBoundingClientRect();
      const doc = el.contentDocument!;
      const all = [...doc.body.querySelectorAll("*")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      return {
        left: box.left + Math.min(...all.map((r) => r.left)),
        right: box.left + Math.max(...all.map((r) => r.right)),
        width: document.documentElement.clientWidth,
      };
    });
    expect(edges.left).toBeGreaterThanOrEqual(header);
    expect(edges.right).toBeLessThanOrEqual(edges.width - header);
  });

  // qa-docs-15: Last viewed shows its whole time (its zone too), wrapping when it must.
  test("qa-docs-15: Share links' Last viewed is never cut off", async ({ page }) => {
    await sharing(page);
    await page.goto(DOC);
    const last = page.getByTestId("share-links").getByTestId("share-last-viewed").first();
    await expect(last).toHaveText(/\d{1,2}:\d{2}\s?[AP]M/);
    const cell = last.locator("xpath=ancestor::td[1]");
    const cut = await cell.evaluate((td) => {
      const span = td.querySelector("[data-testid=share-last-viewed]")!.getBoundingClientRect();
      const box = td.getBoundingClientRect();
      return td.scrollWidth > td.clientWidth + 1 || span.right > box.right + 1 || getComputedStyle(td).textOverflow === "ellipsis";
    });
    expect(cut).toBe(false);
  });

  // qa-docs-16: the empty Share links card says where to make a link.
  test("qa-docs-16: an empty Share links card points to Share above", async ({ page }) => {
    await sharing(page);
    await page.goto("/documents/usage-alerts-roadmap");
    await expect(page.getByTestId("share-links")).toContainText("No links yet. Use Share above to create one.");
    await expect(page.getByText("Share makes one")).toHaveCount(0);
  });

  // New roadmap offers one theme, named as text with no picker (qa-docs-39, qa3-docs-new.spec.ts).
  for (const kind of ["prd"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      // qa-docs-2: each theme tile shows a picture of its page, never an empty box.
      test(`qa-docs-2 (${kind}, ${scheme}): every theme thumbnail shows a picture of the page`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openNew(page, kind);
        const { thumbs, n } = await thumbnails(page);
        for (let i = 0; i < n; i++) {
          const picture = thumbs.nth(i).getByTestId("theme-thumbnail-picture");
          await expect(picture).toBeVisible();
          expect(await picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
          expect(await ink(page, picture)).toBeGreaterThan(20);
        }
      });
    }
  }

  // qa-onboarding-29: a thumbnail is a still picture: no frame, nothing in it scrolls.
  test("qa-onboarding-29: theme thumbnails have no scrollbars of their own", async ({ page }) => {
    await openNew(page, "prd");
    const { thumbs, n } = await thumbnails(page);
    for (let i = 0; i < n; i++) {
      await expect(thumbs.nth(i).locator("iframe")).toHaveCount(0);
      const scrolls = await thumbs.nth(i).evaluate((root) =>
        [root, ...root.querySelectorAll("*")].some((el) => {
          const o = getComputedStyle(el);
          const can = /(auto|scroll)/.test(o.overflowX + o.overflowY);
          return can && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
        }),
      );
      expect(scrolls).toBe(false);
    }
  });

  // qa-docs-21: How many teams? gives an example answer.
  test("qa-docs-21: How many teams? shows the placeholder e.g. 3", async ({ page }) => {
    await openNew(page, "roadmap");
    await expect(page.getByRole("spinbutton", { name: "How many teams?" })).toHaveAttribute("placeholder", "e.g. 3");
  });

  // qa-docs-22: at 1440 px the theme tiles fill their rows evenly: no lone tile on a row.
  test("qa-docs-22: the Theme grid never leaves a lone tile on a row", async ({ page }) => {
    await openNew(page, "prd");
    const { n } = await thumbnails(page);
    expect(n).toBeGreaterThan(1);
    const rows = () =>
      page.getByRole("radiogroup", { name: "Theme" }).evaluate((group) => {
        const tops = new Map<number, number>();
        for (const tile of group.querySelectorAll("[data-testid^=theme-option-]")) {
          const top = Math.round(tile.getBoundingClientRect().top);
          tops.set(top, (tops.get(top) ?? 0) + 1);
        }
        return [...tops.values()];
      });
    await expect.poll(async () => Math.min(...(await rows()))).toBeGreaterThan(1);
    const counts = await rows();
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  // Review of qa-docs-22: the tiles are laid out before the first paint, never one column first.
  test("qa-docs-22: the Theme grid paints in its final columns, with no shift", async ({ page }) => {
    // Before every frame, note how many columns the Theme grid has (once it holds tiles).
    await page.addInitScript(() => {
      const seen: number[] = [];
      (window as unknown as { __themeCols: number[] }).__themeCols = seen;
      const frame = () => {
        const group = document.querySelector('[role="radiogroup"] [data-testid^="theme-option-"]')?.parentElement;
        if (group) {
          const n = getComputedStyle(group).gridTemplateColumns.split(" ").filter(Boolean).length;
          if (seen[seen.length - 1] !== n) seen.push(n);
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await openNew(page, "prd");
    await thumbnails(page);
    const seen = await page.evaluate(() => (window as unknown as { __themeCols: number[] }).__themeCols);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n > 1)).toBe(true);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // qa-docs-1 on a phone: the button stays light and readable in dark mode.
  test("qa-docs-1 (dark, phone): the Download PDF button is light with dark words", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openShared(page);
    const button = page.getByRole("button", { name: "Download PDF" });
    await expect(button).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(button).toHaveCSS("color", "rgb(15, 23, 42)");
  });

  // qa-docs-2 on a phone: the tiles still show a picture, nothing scrolls sideways.
  test("qa-docs-2 (phone): theme thumbnails show a picture and fit the screen", async ({ page }) => {
    await openNew(page, "prd");
    const { thumbs, n } = await thumbnails(page);
    for (let i = 0; i < n; i++) await expect(thumbs.nth(i).getByTestId("theme-thumbnail-picture")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
