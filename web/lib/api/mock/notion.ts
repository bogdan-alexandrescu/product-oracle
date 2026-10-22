/**
 * Mock of GET /v1/connections/{id}/notion/pages (mock mode only): what the mock Notion
 * connection shared with Product Oracle. Pages of PAGE_SIZE, most recently edited first;
 * a search for "slow" answers with Notion's rate limit, so the retry message shows. The
 * "notion-paged" scenario serves pages of 4 with Research last, so "Load more" brings a
 * parent after its children.
 */
import type { Schemas } from "@/lib/api/client";

type NotionPage = Schemas["NotionPageOut"];

export const MOCK_NOTION_CONNECTION_ID = "c0000000-0000-4000-8000-000000000003";
const PAGE_SIZE = 10;
/** Tests set the "po-mock-scenario" localStorage key to this for small pages, a parent last. */
export const NOTION_PAGED_SCENARIO = "notion-paged";

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const page = (
  n: number,
  title: string,
  parent: number | null,
  edited: string,
  extra: Partial<NotionPage> = {},
): NotionPage => ({
  id: id(n),
  type: "page",
  title,
  icon: null,
  parent_type: parent === null ? "workspace" : "page",
  parent_id: parent === null ? null : id(parent),
  last_edited_at: `2026-10-${edited}:00Z`,
  url: `https://www.notion.so/${id(n).replaceAll("-", "")}`,
  ...extra,
});

/** The shared tree: Product handbook and Research at the top, a database with rows, a page in a column. */
export const MOCK_NOTION_PAGES: NotionPage[] = [
  page(1, "Product handbook", null, "18T09:00", { icon: "📘" }),
  page(2, "Roadmap", 1, "18T08:00", { icon: "🗺️" }),
  page(3, "Q4 plan", 2, "17T16:00"),
  page(4, "Feature requests", 1, "17T15:00", { type: "database", icon: "🗂️" }),
  page(5, "Bulk export", 4, "17T14:00", { parent_type: "database" }),
  page(6, "Dark mode", 4, "17T13:00", { parent_type: "database" }),
  page(7, "Single sign-on", 4, "17T12:00", { parent_type: "database" }),
  page(8, "Research", null, "16T10:00", { icon: "🧪" }),
  page(9, "Customer interviews", 8, "16T09:00"),
  // Icons the picker must not load (plain http, a host that is not Notion's) and one it may.
  page(10, "Interview: Acme", 9, "15T09:00", { icon: "http://www.notion.so/icons/user_gray.svg" }),
  page(11, "Interview: Globex", 9, "15T08:00", { icon: "https://tracker.example.com/pixel.gif" }),
  page(12, "Pricing survey", 8, "14T09:00", { icon: "https://www.notion.so/icons/chart-line_gray.svg" }),
  page(13, "Team notes", null, "12T09:00", { parent_type: "block", parent_id: "b0000000-0000-4000-8000-000000000001" }),
  page(14, "Engineering onboarding", null, "10T09:00", { icon: "🚀" }),
];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function notionPages(url: URL): Response {
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  if (search === "slow") {
    return json(429, { detail: "Notion is limiting requests right now; try again in 20 seconds" }, { "retry-after": "20" });
  }
  const paged = localStorage.getItem("po-mock-scenario") === NOTION_PAGED_SCENARIO;
  const size = paged ? 4 : PAGE_SIZE;
  const all = paged
    ? [...MOCK_NOTION_PAGES.filter((p) => p.title !== "Research"), ...MOCK_NOTION_PAGES.filter((p) => p.title === "Research")]
    : MOCK_NOTION_PAGES;
  const matches = all.filter((p) => !search || p.title.toLowerCase().includes(search));
  const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
  const items = matches.slice(start, start + size);
  const next = start + size < matches.length ? String(start + size) : null;
  return json(200, { items, next_cursor: next } satisfies Schemas["NotionPagesOut"]);
}
