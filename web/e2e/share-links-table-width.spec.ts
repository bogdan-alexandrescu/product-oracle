import { expect, test, type Page } from "./test";
import { login } from "./helpers";

/**
 * QA R-5: on the Detailed roadmap document page, the Share links table's first header
 * ("Label") was squeezed to "Lal" at 1024 wide. Every header and cell reads whole at 1024,
 * 1100, 1200, 1280, 1440, 1920 and 390, light and dark, no action button runs onto a
 * neighbouring cell, and the page never scrolls sideways.
 */

// The Usage alerts roadmap has no links (an empty table); the Platform roadmap's seeded links give rows.
const DOCS = [
  { name: "no links", path: "/documents/usage-alerts-roadmap" },
  { name: "with links", path: "/documents/example-labs-roadmap" },
];

const SIZES = [
  { name: "1024", width: 1024, height: 800 },
  // R-5 fix 2: from about 1200 to 1320 the owner's buttons spilled onto the State column.
  { name: "1100", width: 1100, height: 800 },
  { name: "1200", width: 1200, height: 800 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1600", width: 1600, height: 900 },
  { name: "1920", width: 1920, height: 1000 },
  { name: "390", width: 390, height: 844 },
];

async function openTable(
  page: Page,
  doc: string,
  email: string,
  width: number,
  height: number,
  theme: string,
) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((t) => {
    localStorage.setItem("po-mock-scenario", "sharing");
    localStorage.setItem("oracle-theme", t);
  }, theme);
  await login(page, email);
  await page.goto(doc);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  const table = page.getByTestId("share-links");
  await table.scrollIntoViewIfNeeded();
  await expect(table).toBeVisible();
  return table;
}

for (const who of [
  { role: "approver", email: "approver@example.com" },
  { role: "owner", email: "admin@example.com" },
]) {
  for (const doc of DOCS)
    for (const size of SIZES) {
      for (const theme of ["light", "dark"]) {
        test(`the Share links table (${doc.name}) reads whole for the ${who.role}, ${size.name} wide, ${theme}`, async ({
          page,
        }) => {
          const table = await openTable(
            page,
            doc.path,
            who.email,
            size.width,
            size.height,
            theme,
          );
          // A phone hides the header row (screen readers only), so check it where it shows.
          const headers = table.getByRole("columnheader");
          const count = await headers.count();
          expect(count).toBeGreaterThan(1);
          const label = headers.filter({ hasText: /^Label$/ });
          await expect(label).toHaveCount(1);
          for (let i = 0; i < count; i++) {
            const h = headers.nth(i);
            if (!(await h.isVisible())) continue;
            const m = await h.evaluate((el) => ({
              s: el.scrollWidth,
              c: el.clientWidth,
              t: el.textContent,
            }));
            expect(m.s, `header "${m.t}" is clipped`).toBeLessThanOrEqual(m.c);
          }
          if (size.width > 600) {
            const box = await label.boundingBox();
            expect(
              box!.width,
              "Label column keeps a readable width (160 px) at every width",
            ).toBeGreaterThanOrEqual(160);
          }
          // The label gets the spare room on a wide screen: the mock's longest one stays on one line.
          if (size.width >= 1024 && doc.name === "with links") {
            const long = table.getByRole("cell").filter({ hasText: "Board, September meeting" }).first();
            await expect(long).toBeVisible();
            const lines = await long.evaluate((el) => {
              const r = document.createRange();
              r.selectNodeContents(el);
              return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size;
            });
            if (size.width >= 1440) expect(lines, "the long label wraps").toBe(1);
          }
          const cells = table.getByRole("cell");
          const n = await cells.count();
          for (let i = 0; i < n; i++) {
            const c = cells.nth(i);
            if (!(await c.isVisible())) continue;
            const m = await c.evaluate((el) => ({
              s: el.scrollWidth,
              c: el.clientWidth,
            }));
            expect(m.s).toBeLessThanOrEqual(m.c + 1);
          }
          // Every action button sits whole inside its cell and never runs onto the cell beside it.
          const buttons = table.getByRole("row").getByRole("button");
          for (let i = 0, k = await buttons.count(); i < k; i++) {
            const b = buttons.nth(i);
            if (!(await b.isVisible())) continue;
            const fit = await b.evaluate((el) => {
              const td = el.closest("td")!;
              const cell = td.getBoundingClientRect();
              const r = el.getBoundingClientRect();
              const shown = (n: Element | null) => {
                while (n && (n as HTMLElement).offsetParent === null) n = n.previousElementSibling;
                return n;
              };
              const after = (n: Element | null) => {
                while (n && (n as HTMLElement).offsetParent === null) n = n.nextElementSibling;
                return n;
              };
              const overlaps = [shown(td.previousElementSibling), after(td.nextElementSibling)]
                .filter((n): n is Element => n != null)
                .map((n) => n.getBoundingClientRect())
                .some((o) => r.left < o.right - 1 && r.right > o.left + 1 && r.top < o.bottom && r.bottom > o.top);
              return {
                inside: r.left >= cell.left - 1 && r.right <= cell.right + 1,
                overlaps,
                text: el.textContent,
              };
            });
            expect(fit.overlaps, `button "${fit.text}" runs onto the cell beside it`).toBe(false);
            expect(fit.inside, `button "${fit.text}" is cut off`).toBe(true);
          }
          const page_ = await page.evaluate(() => ({
            s: document.documentElement.scrollWidth,
            w: window.innerWidth,
          }));
          expect(page_.s).toBeLessThanOrEqual(page_.w);
        });
      }
    }
}
