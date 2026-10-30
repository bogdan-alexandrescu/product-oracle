import { MOCK_SCENARIO_KEY } from "../lib/api/mock/server";
import { MOCK_VISUAL_JOB_MS_KEY } from "../lib/api/mock/simple-visuals";
import { THEME_KEY } from "../lib/theme";
import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/*
 * The one-pagers list, the rail's person and a bet's flow, third PRD QA pass, driven through
 * the UI on the mock (invented data) on a desktop (1440x900) and, where the layout differs, a
 * phone (390x844); light and dark where colours change.
 *
 * - p3-29: protects = the whole one-pagers row opens its one-pager (the status, the empty
 *   middle, "Updated ..."), with one link a row; fails_when = only the title is a link.
 * - p3-30: protects = the list is newest first and says so; fails_when = no visible order
 *   (Guided setup, the newest in "simple-plan", not first).
 * - p3-31: protects = a member with no name reads their email once in the rail's person
 *   block; fails_when = the email twice (as the name and the avatar's line).
 * - p3-14: protects = a flow's time reads month first with its day and the zone's friendly name
 *   ("Oct 26, 8:00 AM PT", train AD's month-first call), today too; fails_when = "Oct 26, 8:00 AM PDT" or "7:13 PM PDT".
 * - p3-22: protects = full screen has one scroller and one way out, and the opened flow offers
 *   Comment as full screen does; fails_when = the page scrolls behind it, "Back" beside "Exit
 *   full screen", or no Comment in the opened flow.
 * - p3-23: protects = a decision's "Yes" stands clear of its arrow's head and the next box;
 *   fails_when = the label sits on the head.
 * - p3-24: protects = the "No flow yet" box's dashed border reads 3:1 against its card, light
 *   and dark; fails_when = the pale line all but vanishes in dark.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const ONE_PAGER = "/simple/one-pagers/guided-setup";
const BETS: Record<number, string> = { 2: "“A setup checklist that shows", 3: "“Invite suggestions from the admin's", 4: "“A sample project created on" };
const bet = (page: Page, n: number) => page.getByRole("group", { name: `User flow of ${BETS[n]}` }).getByTestId("flow-row");

async function setUp(page: Page, { scenario = null, scheme = "light", email }: { scenario?: string | null; scheme?: "light" | "dark"; email?: string } = {}) {
  await page.context().addInitScript(
    ([key, value, themeKey, theme, jobKey]) => {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      localStorage.setItem(themeKey, theme);
      localStorage.setItem(jobKey, "1500");
    },
    [MOCK_SCENARIO_KEY, scenario ?? "", THEME_KEY, scheme, MOCK_VISUAL_JOB_MS_KEY] as const,
  );
  await page.emulateMedia({ colorScheme: scheme });
  await login(page, email);
}

async function openOnePagers(page: Page) {
  await page.goto("/simple/one-pagers");
  await expect(page.getByTestId("one-pager-row").first()).toBeVisible();
}

async function openBetFlow(page: Page): Promise<Locator> {
  await page.goto(ONE_PAGER);
  await expect(page.getByTestId("one-pager")).toBeVisible();
  await bet(page, 2).getByRole("button", { name: "Open the flow", exact: true }).click();
  const opened = page.getByTestId("flow-detail");
  await expect(opened.getByTestId("flow-svg")).toBeVisible();
  return opened;
}

/** The link under a point of the page, by its href (null: no link there). */
const linkAt = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("a")?.getAttribute("href") ?? null, [x, y] as const);

for (const [where, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
] as const) {
  test.describe(where, () => {
    test.use({ viewport });

    test(`qa-simple-prd-p3-29: the whole one-pagers row opens its one-pager, one link a row (${where})`, async ({ page }) => {
      await setUp(page);
      await openOnePagers(page);
      const row = page.getByTestId("one-pager-row").first();
      await expect(row.getByRole("link")).toHaveCount(1);
      const href = await row.getByRole("link").getAttribute("href");
      expect(href).toMatch(/^\/simple\/one-pagers\/[\w-]+$/);
      const r = (await row.boundingBox())!;
      const chip = (await row.locator(":scope > :nth-child(2)").boundingBox())!;
      const updated = row.getByText(/^Updated /);
      const u = (await updated.boundingBox())!;
      // The status chip, "Updated ...", and the row's empty top edge all lie under the one link.
      for (const [x, y] of [
        [chip.x + chip.width / 2, chip.y + chip.height / 2],
        [u.x + u.width / 2, u.y + u.height / 2],
        [r.x + r.width / 2, r.y + 3],
      ]) {
        expect(await linkAt(page, x, y), `the point ${Math.round(x)},${Math.round(y)}`).toBe(href);
      }
      // As a person does: a click where "Updated ..." reads.
      await page.mouse.click(u.x + u.width / 2, u.y + u.height / 2);
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(page.getByTestId("one-pager")).toBeVisible();
    });

    test(`qa-simple-prd-p3-22: full screen has one scroller and one way out; the opened flow offers its Comment (${where})`, async ({ page }) => {
      await setUp(page);
      const opened = await openBetFlow(page);
      const pageScrolls = () =>
        page.evaluate(() => {
          const html = document.documentElement;
          const locked = ["hidden", "clip"].includes(getComputedStyle(html).overflowY) || ["hidden", "clip"].includes(getComputedStyle(document.body).overflowY);
          return !locked && html.scrollHeight > html.clientHeight + 1;
        });
      // The one-pager behind is taller than the window.
      expect(await pageScrolls()).toBe(true);
      await opened.getByRole("button", { name: "Full screen" }).click();
      const full = page.getByTestId("flow-fullscreen");
      await expect(full).toBeVisible();
      // One scroller: the page behind stops; within the viewer, at most one box scrolls.
      expect(await pageScrolls()).toBe(false);
      const scrollers = await full.evaluate((root) =>
        [root, ...root.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1 && el.getBoundingClientRect().width > 0).length,
      );
      expect(scrollers).toBeLessThanOrEqual(1);
      // One way out: Exit full screen, with no back link beside it.
      await expect(full.getByRole("button", { name: "Exit full screen" })).toHaveCount(1);
      await expect(full.getByRole("button", { name: /^Back$/ })).toHaveCount(0);
      await expect(full.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
      await full.getByRole("button", { name: "Exit full screen" }).click();
      await expect(full).toHaveCount(0);
      expect(await pageScrolls()).toBe(true);
      // The same Comment in the opened flow: it opens the comments, full screen.
      await opened.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.getByTestId("flow-fullscreen").getByTestId("flow-comments-panel")).toBeVisible();
      await expect(page.getByTestId("flow-fullscreen").getByTestId("flow-version")).toHaveText("Version 1 of 1");
    });

    test(`qa-simple-prd-p3-23: a decision's Yes stands clear of its arrow's head and the next box (${where})`, async ({ page }) => {
      await setUp(page);
      const opened = await openBetFlow(page);
      const labels = await opened.getByTestId("flow-svg").evaluate((svg) => {
        const shapes = [...svg.querySelectorAll<SVGGraphicsElement>("[data-shape]")].map((s) => s.getBBox());
        return [...svg.querySelectorAll<SVGTextElement>("text")]
          .filter((t) => t.textContent === "Yes")
          .map((t) => {
            const d = t.parentElement?.querySelector("path[marker-end]")?.getAttribute("d") ?? "";
            const m = /^M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)$/.exec(d);
            const b = t.getBBox();
            if (!m) return { d, ok: false, why: "no straight arrow beside it" };
            const [x1, y1, x2, y2] = m.slice(1).map(Number);
            if (y1 === y2) {
              // Across: above the line, clear of the head (10.5 px tall), and short of the next box.
              const next = shapes.find((s) => Math.abs(s.x - (x2 + 2)) < 1.5 && s.y <= y1 && s.y + s.height >= y1);
              const clearOfHead = b.y + b.height <= y1 - 7;
              const clearOfBox = !next || b.x + b.width <= next.x - 8;
              return { d, ok: clearOfHead && clearOfBox, why: `bottom ${b.y + b.height} line ${y1}; right ${b.x + b.width} next ${next?.x}` };
            }
            // Down: beside the line, clear of the head's 5.25 px half-width.
            return { d, ok: b.x >= x1 + 7, why: `left ${b.x} line ${x1} (to ${y2})` };
          });
      });
      expect(labels.length).toBeGreaterThan(0);
      for (const l of labels) expect(l.ok, l.why).toBe(true);
    });
  });
}

test.describe("desktop", () => {
  test.use({ viewport: DESKTOP });

  test("qa-simple-prd-p3-30: one-pagers are newest first, and the list says so", async ({ page }) => {
    await setUp(page);
    await openOnePagers(page);
    const list = page.getByTestId("simple-one-pagers");
    await expect(list.getByTestId("one-pagers-order")).toHaveText("Newest first");
    const days = (await list.getByTestId("one-pager-row").getByText(/^Updated /).allTextContents()).map((t) => Date.parse(t.replace(/^Updated /, "")));
    expect(days.length).toBeGreaterThan(1);
    for (const d of days) expect(Number.isNaN(d)).toBe(false);
    for (let i = 1; i < days.length; i++) expect(days[i]).toBeLessThanOrEqual(days[i - 1]);
  });

  test("qa-simple-prd-p3-30: in the planned company, Guided setup (changed last) comes first", async ({ page }) => {
    await setUp(page, { scenario: "simple-plan" });
    await openOnePagers(page);
    await expect(page.getByTestId("one-pager-row").first().getByRole("link")).toHaveText("Guided setup");
  });

  test("qa-simple-prd-p3-31: a member with no name reads their email once in the rail", async ({ page }) => {
    await setUp(page, { email: "viewer@example.com" });
    await openOnePagers(page);
    const person = page.getByTestId("simple-person");
    await expect(person.getByTestId("simple-person-name")).toHaveText("viewer@example.com");
    const text = (await person.textContent()) ?? "";
    expect(text.split("viewer@example.com").length - 1).toBe(1);
    expect(((await person.innerText()) ?? "").split("viewer@example.com").length - 1).toBe(1);
    // The avatar still names whose account it opens.
    await expect(page.getByTestId("user-menu")).toHaveAccessibleName("Account viewer@example.com");
  });

  test("qa-simple-prd-p3-14: a flow's time reads month first with its day and the friendly zone, today too", async ({ page }) => {
    await setUp(page);
    await page.goto(ONE_PAGER);
    await expect(page.getByTestId("one-pager")).toBeVisible();
    // Drawn Oct 26 (not today: the mock's today is Oct 22).
    await expect(bet(page, 2).getByTestId("flow-drawn")).toHaveText("Version 1 · drawn Oct 26, 8:00 AM PT");
    await bet(page, 2).getByRole("button", { name: "Open the flow", exact: true }).click();
    await expect(page.getByTestId("flow-detail").getByTestId("flow-drawn")).toHaveText("Version 1 · drawn Oct 26, 8:00 AM PT");
    await page.getByTestId("flow-detail").getByRole("button", { name: "Close", exact: true }).click();
    // Drawn today: its day still shows.
    const row = bet(page, 3);
    await row.getByRole("button", { name: "Ask Oracle to draw it" }).click();
    await expect(row.getByTestId("flow-drawn")).toHaveText(/^Version 1 · drawn Oct 22, \d{1,2}:\d{2} [AP]M PT$/, { timeout: 15_000 });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`qa-simple-prd-p3-24: a "No flow yet" box's dashed border reads against its card (${scheme})`, async ({ page }) => {
      await setUp(page, { scheme });
      await page.goto(ONE_PAGER);
      await expect(page.getByTestId("one-pager")).toBeVisible();
      for (const n of [3, 4]) {
        const empty = bet(page, n).getByTestId("flow-empty");
        await expect(empty).toContainText("No flow yet");
        const box = empty.locator("span[aria-hidden]").first();
        const look = await box.evaluate((el) => {
          const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
          const rgba = (c: string): [number, number, number, number] => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = "#000";
            ctx.fillStyle = c;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0], d[1], d[2], d[3] / 255];
          };
          const lum = ([r, g, b]: number[]) => {
            const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          let at: Element | null = el.parentElement;
          let card = "rgb(255,255,255)";
          while (at) {
            const bg = getComputedStyle(at).backgroundColor;
            if (rgba(bg)[3] > 0.5) {
              card = bg;
              break;
            }
            at = at.parentElement;
          }
          const cs = getComputedStyle(el);
          const lb = lum(rgba(cs.borderTopColor));
          const lc = lum(rgba(card));
          return { style: cs.borderTopStyle, width: parseFloat(cs.borderTopWidth), ratio: (Math.max(lb, lc) + 0.05) / (Math.min(lb, lc) + 0.05) };
        });
        expect(look.style).toBe("dashed");
        expect(look.width).toBeGreaterThanOrEqual(1);
        expect(look.ratio, `bet ${n}'s box border against its card`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
