/**
 * Prose guard (owner's rule, Nov 5: "No excessive prose on any web page when that can be
 * hidden in nice way behind a tooltip or tick"). Visits every page of Simple and Detailed in
 * the mock production build, as the owner and as a viewer, at 1440 wide, counts the visible
 * prose on each, writes the counts to test-results/prose/ and fails when a page's count is
 * above its ceiling in e2e/prose-ceilings.json. Ceilings only go down, and never by hand:
 * `npm run prose:ratchet` reruns this spec and lowers every ceiling to today's count, and the
 * spec fails when a ceiling is above the merge base's (origin/main; PROSE_BASE names another
 * ref) or, for a page the merge base has no ceiling for, above the page's count.
 *
 * The rule, as counted here:
 * - Text is what the page renders and a person can see: text nodes whose element passes
 *   checkVisibility() (not display:none, visibility:hidden or opacity 0, not inside a closed
 *   <details>), is at least 2 px each way (no screen-reader-only text) and has no
 *   [hidden] or [aria-hidden="true"] ancestor. Text below the fold counts; nothing is clicked.
 * - Not counted: tooltips and (i) popovers ([role="tooltip"], [popover]), titles and
 *   aria-labels (attributes, never text), form fields (input, textarea, select, option,
 *   contenteditable), code (code, pre, kbd), and user content: PRD and one-pager bodies,
 *   chat and meeting messages, and anything else a person wrote, marked in the app with
 *   [data-user-content] (see USER_CONTENT below for the other selectors that mean the same).
 * - The text left is joined per block (a run of inline text up to its nearest non-inline
 *   ancestor), with a space where one element's text meets another's, so "<b>9</b>decisions"
 *   reads as two words (text nodes side by side in one element, as React renders "comment{s}",
 *   join as they are), whitespace squeezed, and split into sentences after ". ", "! " or "? ".
 * - A sentence is prose when it has 8 or more words; a word is a run of non-space characters
 *   with at least one letter (so dates and numbers do not count: "Oct 30, 2026, 2:49 PM"
 *   is two words, "Oct" and "PM").
 * - A page's count is the number of words in its prose sentences. The guard fails when that
 *   is above the page's ceiling for the role; a page with no ceiling yet fails until
 *   `npm run prose:ratchet` records it. A page that opened "not found" fails, and its count is
 *   written as missing, which the ratchet ignores.
 *
 * A lane that adds prose hides it (an InfoTip, a tick whose tooltip says why, a link) or this
 * spec fails (docs/agents/lane-rules.md).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./test";
import { login, seedRoadmapReview } from "./helpers";
import { MOCK_INTERVIEW_TOKEN } from "../lib/api/mock/interviews";
import { BEFORE_DRAFTING } from "../lib/api/mock/intake";
import { CHAT_MEETING_ID } from "../lib/api/mock/simple-chat";
import { MOCK_SCENARIO_KEY } from "../lib/api/mock/ids";
import { ROADMAP_REVIEW_RUN } from "../lib/api/mock/runs";

const MIN_WORDS = 8;
const MISSING = /doesn['’]t exist|was not found|could not be found|may have been drafted into a PRD/i;
const OUT = path.join(__dirname, "..", "test-results", "prose");
const CEILINGS_FILE = path.join(__dirname, "prose-ceilings.json");

/** Selectors whose text is never counted (the header's "Not counted"). */
const SKIP = [
  "[role=tooltip]",
  "[popover]",
  "[hidden]",
  "[aria-hidden=true]",
  "input",
  "textarea",
  "select",
  "option",
  "[contenteditable]:not([contenteditable=false])",
  "code",
  "pre",
  "kbd",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
];
/** User content: what a person wrote, shown as written. */
const USER_CONTENT = [
  "[data-user-content]",
  // PRD sections as written (SectionView, EditSection, a ritual's body, the compare view).
  ".doc-body",
  "[data-section-body]",
  "[data-testid=word-diff]",
  // A one-pager's lines and chat or meeting messages.
  "[data-testid=one-pager-line-text]",
  "[data-testid=chat-message-body]",
];

type Role = "owner" | "viewer";
const ROLES: Record<Role, string> = { owner: "admin@example.com", viewer: "viewer@example.com" };

/**
 * A page: its route (the ceilings' key) and how to reach it. `go` is a path, or a path then
 * patterns of the links to follow from it (the first link whose path matches, in turn), for a page whose id only the mock knows;
 * `scenario` the mock scenario that has its data, or `seed` adds it after signing in (as
 * e2e/helpers.ts's seeds do for other specs). Not visited: the signed-out pages (/login,
 * /access, /oauth/consent, a shared link /s/<token>) and the routes that only redirect
 * (/, /company, /settings, /requests/new, /simple/prds/<doc>).
 */
type Visit = { route: string; go: string | string[]; scenario?: string; seed?: (page: Page) => Promise<unknown> };

const SIMPLE: Visit[] = [
  { route: "/simple", go: "/simple" },
  { route: "/simple/decisions", go: "/simple/decisions" },
  { route: "/simple/goals", go: "/simple/goals" },
  { route: "/simple/meetings", go: "/simple/meetings" },
  { route: "/simple/meetings/[id]", go: ["/simple/meetings", "/simple/meetings/[^/]+"] },
  { route: "/simple/meetings/[id]/chat", go: `/simple/meetings/${CHAT_MEETING_ID}/chat` },
  { route: "/simple/one-pagers", go: "/simple/one-pagers" },
  { route: "/simple/one-pagers/[doc]", go: "/simple/one-pagers/guided-setup" },
  { route: "/simple/priorities", go: "/simple/priorities" },
  { route: "/simple/roadmap", go: "/simple/roadmap" },
];

const DETAILED: Visit[] = [
  { route: "/home", go: "/home" },
  { route: "/inbox", go: "/inbox" },
  { route: "/documents", go: "/documents" },
  { route: "/documents/new", go: "/documents/new" },
  { route: "/documents/[doc]", go: "/documents/checkout-redesign" },
  { route: "/documents/[doc]/composition", go: "/documents/checkout-redesign/composition" },
  { route: "/documents/[doc]/diff", go: "/documents/checkout-redesign/diff" },
  { route: "/documents/[doc]/public", go: "/documents/checkout-redesign/public" },
  { route: "/documents/[doc]/publish", go: "/documents/saved-carts/publish" },
  { route: "/documents/[doc]/v/[n]", go: "/documents/checkout-redesign/v/2" },
  { route: "/documents/[doc]/v/[n]/evidence", go: "/documents/checkout-redesign/v/2/evidence" },
  { route: "/documents/[doc]/v/[n]/impact", go: "/documents/checkout-redesign/v/2/impact" },
  { route: "/documents/[doc]/v/[n]/items", go: "/documents/checkout-redesign/v/2/items" },
  { route: "/documents/[doc]/v/[n]/present", go: "/documents/saved-carts/v/2/present" },
  { route: "/documents/[doc]/v/[n]/quality", go: "/documents/saved-carts/v/2/quality" },
  { route: "/documents/[doc]/v/[n]/roadmap", go: "/documents/usage-alerts/v/1/roadmap" },
  { route: "/briefs/[id]", go: ["/documents/checkout-redesign", "/briefs/[^/]+"] },
  // The mock's ids are stable for a scenario (its seed is seeded): Guided setup's entity and R-90's deletion.
  { route: "/impact/entities/[id]", scenario: "impact", go: "/impact/entities/959a57aa-38ad-4d78-8178-3342688ce78c" },
  { route: "/impact/changes/[id]", scenario: "impact", go: "/impact/changes/b7dce326-2a47-4000-8b74-562e8ac05a9c" },
  { route: "/baseline", go: "/baseline" },
  { route: "/priorities", go: "/priorities" },
  { route: "/plan", go: "/plan" },
  { route: "/plan/dates", go: "/plan/dates" },
  { route: "/plan/documents", go: "/plan/documents" },
  { route: "/plan/outcomes", go: "/plan/outcomes" },
  { route: "/plan/reports", go: "/plan/reports" },
  { route: "/plan/reports/latest", go: "/plan/reports/latest" },
  { route: "/plan/reports/[id]", scenario: "alignment-report", go: ["/plan/reports", "/plan/reports/(?!latest)[^/]+"] },
  { route: "/roadmap/changelog", go: "/roadmap/changelog" },
  { route: "/roadmap/launches", go: "/roadmap/launches" },
  { route: "/requests", go: "/requests" },
  { route: "/requests/themes", go: "/requests/themes" },
  { route: "/requests/to-decide", go: "/requests/to-decide" },
  { route: "/requests/interviews", go: "/requests/interviews" },
  { route: "/requests/interviews/[id]", go: "/requests/interviews/66952c66-1c80-4e84-84a4-838e1243af88" },
  { route: "/intakes/[id]", scenario: "before-drafting", go: `/intakes/${BEFORE_DRAFTING.intakeId}` },
  { route: "/runs", go: "/runs" },
  { route: "/runs/[id]", go: ["/runs", "/runs/[^/]+"] },
  {
    route: "/runs/[id]/review/[checkpoint]",
    seed: seedRoadmapReview,
    go: `/runs/${ROADMAP_REVIEW_RUN.run.id}/review/${ROADMAP_REVIEW_RUN.run.checkpoints[0].id}`,
  },
  { route: "/sources", go: "/sources" },
  { route: "/company/decisions", go: "/company/decisions" },
  { route: "/company/market", go: "/company/market" },
  { route: "/company/metrics", go: "/company/metrics" },
  { route: "/company/rituals", go: "/company/rituals" },
  // The market scenario's competitive digest (MARKET_DIGEST_ID in lib/api/mock/server.ts).
  { route: "/company/rituals/[occurrence]", scenario: "market", go: "/company/rituals/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" },
  { route: "/company/strategy", go: "/company/strategy" },
  { route: "/company/updates", go: "/company/updates" },
  { route: "/specs/[id]/design/[versionId]", go: "/specs/c3000000-0000-4000-8000-000000000001/design/c3000000-0000-4000-8000-000000000013" },
  { route: "/design", go: "/design" },
  { route: "/account", go: "/account" },
  { route: "/i/[token]", go: `/i/${MOCK_INTERVIEW_TOKEN}` },
  { route: "/settings/analytics", go: "/settings/analytics" },
  { route: "/settings/api-tokens", go: "/settings/api-tokens" },
  { route: "/settings/autonomy", go: "/settings/autonomy" },
  { route: "/settings/claude-accounts", go: "/settings/claude-accounts" },
  { route: "/settings/company", go: "/settings/company" },
  { route: "/settings/connections", go: "/settings/connections" },
  { route: "/settings/members", go: "/settings/members" },
  { route: "/settings/notifications", go: "/settings/notifications" },
  { route: "/settings/sources", go: "/settings/sources" },
  { route: "/settings/templates", go: "/settings/templates" },
  { route: "/settings/templates/new", go: "/settings/templates/new" },
  { route: "/settings/templates/[key]", go: "/settings/templates/one-pager" },
  { route: "/settings/themes", go: "/settings/themes" },
  { route: "/settings/themes/new", go: "/settings/themes/new" },
  { route: "/settings/themes/[key]", go: "/settings/themes/clean-document" },
  { route: "/settings/trash", go: "/settings/trash" },
  { route: "/settings/webhooks", go: "/settings/webhooks" },
];

type Ceilings = Record<Role, Record<string, number>>;
const ceilings: Ceilings = fs.existsSync(CEILINGS_FILE) ? JSON.parse(fs.readFileSync(CEILINGS_FILE, "utf8")) : { owner: {}, viewer: {} };

/**
 * The ceilings on the merge base (with origin/main, or PROSE_BASE), or an error saying why
 * they could not be read. A merge base without the file has no ceilings yet. The spec only
 * reads the repository, never fetches: CI's mock shards check out with main's history
 * (.github/workflows/ci.yml), and run locally it uses the ref that is there.
 */
function baseCeilings(): Ceilings | string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const ref = process.env.PROSE_BASE || "origin/main";
  let base: string | null = null;
  try {
    base = git("merge-base", "HEAD", ref);
  } catch {
    // No such ref, or a shallow checkout without the history: the error below says what to run.
  }
  if (!base) return `no merge base with ${ref}: run git fetch origin main (with --unshallow in a shallow clone), or set PROSE_BASE to the branch the PR goes into`;
  try {
    return JSON.parse(git("show", `${base}:web/e2e/prose-ceilings.json`));
  } catch {
    return { owner: {}, viewer: {} };
  }
}
const base = baseCeilings();

/** Every route the guard visits, for the ratchet to drop the ceilings of routes gone since. */
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "routes.json"), JSON.stringify([...SIMPLE, ...DETAILED].map((v) => v.route)));

/** Waits until the page's text stops changing (the mock answers in the browser). */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const len = await page.evaluate(() => document.body.innerText.length);
    if (len === last) return;
    last = len;
    await page.waitForTimeout(300);
  }
}

/** Follows `go` to the page, returning the path it opened, or null when a link is missing. */
async function open(page: Page, go: string | string[]): Promise<string | null> {
  const hops = typeof go === "string" ? [go] : go;
  await page.goto(hops[0]);
  await settle(page);
  for (const prefix of hops.slice(1)) {
    const href = await page.evaluate(
      (p) => [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.getAttribute("href") ?? "").find((h) => new RegExp(`^${p}$`).test(h.split("?")[0])),
      prefix,
    );
    if (!href) return null;
    await page.goto(href);
    await settle(page);
  }
  return new URL(page.url()).pathname;
}

type Count = { words: number; sentences: string[] };

/** The header's rule, in the page. */
function countProse(page: Page): Promise<Count> {
  return page.evaluate(
    ({ skip, minWords }) => {
      const blocks = new Map<Element, string[]>();
      const last = new Map<Element, Node>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue ?? "";
        if (!text.trim()) continue;
        const el = n.parentElement;
        if (!el || el.closest(skip)) continue;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        let block: Element = el;
        while (block.parentElement && /^(inline|contents)$/.test(getComputedStyle(block).display)) block = block.parentElement;
        const parts = blocks.get(block) ?? [];
        if (parts.length && last.get(block) === n.previousSibling) parts[parts.length - 1] += text;
        else parts.push(text);
        blocks.set(block, parts);
        last.set(block, n);
      }
      const sentences: string[] = [];
      let words = 0;
      for (const parts of blocks.values()) {
        const text = parts.join(" ").replace(/\s+/g, " ").trim();
        for (const s of text.split(/(?<=[.!?])\s+/)) {
          const n = s.split(" ").filter((w) => /\p{L}/u.test(w)).length;
          if (n >= minWords) {
            sentences.push(s);
            words += n;
          }
        }
      }
      return { words, sentences };
    },
    { skip: [...SKIP, ...USER_CONTENT].join(","), minWords: MIN_WORDS },
  );
}

const fileName = (role: Role, route: string) => `${role}${route.replace(/[^a-z0-9-]+/gi, "_")}.json`;

/**
 * Pages in groups of CHUNK per sign-in (a page with its own scenario or seed alone), so the
 * guard takes a few minutes; each page is its own step and fails on its own (expect.soft).
 */
const CHUNK = 8;
function groups(pages: Visit[]): Visit[][] {
  const own = pages.filter((v) => v.scenario || v.seed).map((v) => [v]);
  const rest = pages.filter((v) => !v.scenario && !v.seed);
  const out: Visit[][] = [];
  for (let i = 0; i < rest.length; i += CHUNK) out.push(rest.slice(i, i + CHUNK));
  return [...out, ...own];
}

async function check(page: Page, role: Role, mode: string, v: Visit) {
  const opened = await open(page, v.go);
  expect.soft(opened, `no link to ${v.route} on the way there (${JSON.stringify(v.go)})`).not.toBeNull();
  if (!opened) return;
  // A stale id would count a "not found" page instead of the real one; the ratchet skips it.
  const body = await page.locator("body").innerText();
  const missing = MISSING.test(body);
  expect.soft(body, `${v.route} opened a missing page (${opened})`).not.toMatch(MISSING);
  const { words, sentences } = await countProse(page);
  fs.writeFileSync(path.join(OUT, fileName(role, v.route)), JSON.stringify({ role, mode, route: v.route, url: opened, missing, words, sentences }, null, 2));
  const ceiling = ceilings[role]?.[v.route];
  expect.soft(ceiling, `${v.route} as ${role} has no ceiling in e2e/prose-ceilings.json: run npm run prose:ratchet`).toBeDefined();
  if (ceiling === undefined) return;
  // A page new since the merge base starts at its count, never above it.
  if (typeof base !== "string" && base[role]?.[v.route] === undefined && !missing)
    expect
      .soft(ceiling, `${v.route} as ${role} is new since the merge base: its ceiling starts at its count, ${words} (npm run prose:ratchet), never above it`)
      .toBeLessThanOrEqual(words);
  expect
    .soft(
      words,
      `${v.route} as ${role}: ${words} words of visible prose, ceiling ${ceiling}. Hide the new explanation behind an InfoTip, a tick or a link (docs/agents/lane-rules.md). Prose sentences:\n${sentences.join("\n")}`,
    )
    .toBeLessThanOrEqual(ceiling);
}

test.describe("prose guard", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no ceiling is above the merge base's (ceilings are never raised by hand)", () => {
    expect(typeof base === "string" ? base : null, "the merge base's ceilings").toBeNull();
    if (typeof base === "string") return;
    const raised = (Object.keys(ROLES) as Role[]).flatMap((role) =>
      Object.entries(ceilings[role] ?? {})
        .filter(([route, n]) => base[role]?.[route] !== undefined && n > base[role][route])
        .map(([route, n]) => `${role} ${route}: ${n}, was ${base[role][route]}`),
    );
    expect(raised, "Ceilings in e2e/prose-ceilings.json only go down (npm run prose:ratchet); hide the new prose instead").toEqual([]);
  });

  for (const [mode, pages] of [["Simple", SIMPLE], ["Detailed", DETAILED]] as const) {
    for (const role of Object.keys(ROLES) as Role[]) {
      for (const group of groups(pages)) {
        test(`${mode} as ${role}: ${group.map((v) => v.route).join(", ")}`, async ({ page }) => {
          const [first] = group;
          if (first.scenario) await page.addInitScript(([k, s]) => localStorage.setItem(k, s), [MOCK_SCENARIO_KEY, first.scenario] as const);
          await login(page, ROLES[role]);
          if (first.seed) await first.seed(page);
          for (const v of group) await test.step(v.route, () => check(page, role, mode, v));
        });
      }
    }
  }
});
