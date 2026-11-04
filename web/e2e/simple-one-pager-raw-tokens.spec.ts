import { login } from "./helpers";
import { expect, test, type Locator, type Page } from "./test";

/**
 * raw-tokens-everywhere (production findings, Nov 3): a PRD's Simple one-pager showed a writer's
 * "[c:gametric]" and "[c:convdef]" in an opened storyboard's text. The bet's drawing as stored
 * carries those tokens (the mock seeds them, as Oracle's writer left them); a person reads the
 * storyboard, the opened flow and a line's sources without any "[c:", "[l:" or "[s:".
 *
 * Test cards (protects / fails_when / no_claim):
 *
 * - "the storyboard, the opened flow and a line's sources show no raw tokens": protects=the
 *   storyboard's cards ("See the setup checklist", "Invite now or later?", "Yes: the invite form
 *   opens.") and the opened flow's steps read as words, and the line's Sources read the PRD's
 *   section without its "[c:c1]"; fails_when=any "[c:" shows; no_claim=the API's flows
 *   (test_raw_tokens_everywhere.py).
 * - "the mock's generated texts carry no raw tokens": protects=every mock route that serves
 *   generated text (each one-pager, each visual subject and version, the notifications, each
 *   document version and its sections) answers with no "[c:", "[l:" or "[s:", a section's own
 *   Markdown only with "[c:id]" (the page renders its chips); fails_when=a route serves one.
 */

const RAW = /\[[cls]:/;

async function tap(l: Locator) {
  await l.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await l.click();
}

async function noRaw(l: Locator) {
  await expect(l).toBeVisible();
  expect(await l.innerText()).not.toMatch(RAW);
}

for (const phone of [false, true]) {
  const where = phone ? "phone" : "desktop";
  test.describe(where, () => {
    test.use(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 820 } });

    test(`the storyboard, the opened flow and a line's sources show no raw tokens (${where})`, async ({ page }) => {
      await login(page);
      await page.goto("/simple/one-pagers/guided-setup");
      const line = page.getByRole("group", { name: "User flow of “A setup checklist that shows" });
      await tap(line.getByRole("button", { name: "Open the storyboard" }));
      const board = page.getByTestId("flow-storyboard");
      if (phone) {
        await expect(board.getByTestId("story-card")).toContainText("Sign in as a new admin");
        await noRaw(board);
        for (const n of [2, 3]) {
          await tap(board.getByRole("button", { name: `Step ${n}` }));
          await noRaw(board);
        }
        await expect(board.getByTestId("story-card")).toContainText("Decision: Invite now or later?");
        await expect(board.getByTestId("story-yes-no")).toContainText("Yes: the invite form opens.");
      } else {
        const cards = board.getByTestId("story-card");
        await expect(cards.nth(1)).toContainText("See the setup checklist");
        await expect(cards.nth(2)).toContainText("Invite now or later?");
        await expect(cards.nth(2).getByTestId("story-yes-no")).toContainText("Yes: the invite form opens.No:");
        await noRaw(board);
      }
      await tap(board.getByRole("button", { name: "Close" }));
      await tap(line.getByRole("button", { name: "Flow for “A setup checklist that shows" }));
      const opened = page.getByTestId("flow-detail");
      await expect(opened.getByTestId("flow-steps")).toContainText("Decision: Invite now or later?");
      await noRaw(opened);
      await tap(opened.getByRole("button", { name: "Close" }));
      await tap(page.getByRole("button", { name: /A setup checklist that shows the next step/ }).first());
      const sources = page.getByRole("region", { name: "Sources of “A setup checklist that shows" });
      await expect(sources).toContainText("From the PRD");
      await noRaw(sources);
    });

    test(`the mock's generated texts carry no raw tokens (${where})`, async ({ page }) => {
      await login(page);
      await page.goto("/simple/one-pagers/guided-setup");
      await expect(page.getByTestId("one-pager")).toBeVisible();
      const found = await scan(page, await mockRoutes(page));
      expect(found).toEqual([]);
    });
  });
}

/**
 * Every mock route that serves generated text people see: each one-pager, each visual subject
 * (and each of its versions), the notifications, and each document version with its sections.
 */
async function mockRoutes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Db = {
      simple_one_pager?: { doc: { slug: string } };
      simple_one_pagers?: Record<string, { doc: { slug: string } }>;
      simple_visuals?: { visuals: Record<string, { kind: string; id: string; versions: { version: number }[] }> };
      documents: { id: string; slug: string }[];
      versions: { document_id: string; number: number }[];
    };
    const write = (globalThis as { __poMockWrite?: <T>(change: (db: Db) => T) => Promise<T> }).__poMockWrite!;
    return write((db) => {
      const out = ["/v1/me/notifications"];
      for (const op of [db.simple_one_pager, ...Object.values(db.simple_one_pagers ?? {})]) if (op) out.push(`/v1/simple/one-pagers/${op.doc.slug}`);
      for (const v of Object.values(db.simple_visuals?.visuals ?? {})) {
        const at = `/v1/simple/visuals/${v.kind}/${encodeURIComponent(v.id)}`;
        out.push(at, ...v.versions.map((f) => `${at}/versions/${f.version}`));
      }
      for (const d of db.documents) {
        for (const v of db.versions.filter((x) => x.document_id === d.id)) out.push(`/v1/documents/${d.slug}/versions/${v.number}`);
      }
      return out;
    });
  });
}

/**
 * Every string a route answers with that carries a raw token. A section's own Markdown may cite
 * with "[c:id]" (the page renders its chips) but carries no "[l:" or "[s:", except the one section
 * seeded with them for the renderer's spec (document-section-raw-tokens.spec.ts).
 */
async function scan(page: Page, paths: string[]): Promise<string[]> {
  return page.evaluate(async (paths) => {
    const fetcher = (globalThis as { __poMockFetch?: (r: Request) => Promise<Response> }).__poMockFetch!;
    const out: string[] = [];
    const walk = (v: unknown, at: string, key: string) => {
      if (typeof v === "string") {
        const markdown = ["body", "body_md", "markdown"].includes(key);
        const seeded = at.startsWith("/v1/documents/visit-reminders/") && v.includes("[s:rebook]");
        if ((markdown ? /\[[ls]:/ : /\[[cls]:/).test(v) && !seeded) out.push(`${at}: ${v}`);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`, k);
    };
    for (const p of paths) {
      const r = await fetcher(new Request(new URL(p, location.origin)));
      if (!r.ok) {
        out.push(`${p}: ${r.status}`);
        continue;
      }
      walk(await r.json(), p, "");
    }
    return out;
  }, paths);
}
