/**
 * Mock of the source pickers' browse endpoints (mock mode only): the Slack channels and
 * GitHub repos a connection can read, paged and searchable as in
 * oracle/connections/browse_slack.py and browse_github.py. Searching "ratelimit" answers
 * 429, so the picker's retry message can be exercised.
 */
import type { Schemas } from "@/lib/api/client";

type Channel = Schemas["SlackChannelOut"];
type Repo = Schemas["GithubRepoOut"];

const PAGE = 20;

const channel = (id: string, name: string, num_members: number, extra: Partial<Channel> = {}): Channel => ({
  id,
  name,
  is_private: id.startsWith("G"),
  is_archived: false,
  num_members,
  topic: null,
  ...extra,
});

const CHANNELS: Channel[] = [
  channel("C0123PRODUCT", "product", 42, { topic: "Product decisions and launches" }),
  channel("C0456FEEDBACK", "customer-feedback", 17),
  channel("G0789ROADMAP", "roadmap", 6, { topic: "Quarterly roadmap" }),
  channel("C0100GENERAL", "general", 128),
  channel("C0101DESIGN", "design", 14),
  channel("C0102ENG", "eng", 38),
  channel("C0103BACKEND", "eng-backend", 21),
  channel("C0104FRONTEND", "eng-frontend", 19),
  channel("G0105LEADS", "leads", 7),
  channel("C0106SUPPORT", "support", 25),
  channel("C0107SALES", "sales", 16),
  channel("C0108MARKETING", "marketing", 12),
  channel("C0109RELEASES", "releases", 54),
  channel("C0110INCIDENTS", "incidents", 33),
  channel("G0111HIRING", "hiring", 5),
  channel("C0112ANALYTICS", "analytics", 11),
  channel("C0113ONBOARDING", "onboarding", 9),
  channel("C0114PRICING", "pricing", 8),
  channel("C0115RESEARCH", "user-research", 10),
  channel("C0116RANDOM", "random", 120),
  channel("C0117MOBILE", "mobile", 13),
  channel("C0118DATA", "data-platform", 15),
  channel("G0119BOARD", "board-prep", 4),
  channel("C0120PARTNERS", "partners", 18),
  channel("C0121OLD", "launch-2024", 30, { is_archived: true }),
];

const repo = (full_name: string, pushed_at: string, extra: Partial<Repo> = {}): Repo => {
  const [owner, name] = full_name.split("/");
  return { full_name, owner, name, is_private: false, is_archived: false, description: null, pushed_at, ...extra };
};

const day = (n: number) => new Date(Date.UTC(2026, 9, 19 - n, 9, 30)).toISOString();

const REPOS: Repo[] = [
  repo("example-org/example-app", day(0), { is_private: true, description: "The web app" }),
  repo("example-org/docs", day(1), { description: "Product docs" }),
  repo("example-org/billing-api", day(2), { is_private: true, description: "Invoices and plans" }),
  repo("example-org/mobile", day(3), { is_private: true }),
  repo("example-org/design-system", day(4)),
  repo("example-org/infra", day(5), { is_private: true, description: "Terraform and deploys" }),
  repo("example-org/data-pipeline", day(6), { is_private: true }),
  repo("example-org/marketing-site", day(8)),
  repo("example-org/sdk-js", day(9), { description: "JavaScript SDK" }),
  repo("example-org/sdk-python", day(10), { description: "Python SDK" }),
  repo("example-org/cli", day(12)),
  repo("example-org/auth-service", day(13), { is_private: true }),
  repo("example-org/search", day(15), { is_private: true }),
  repo("example-org/notifications", day(17), { is_private: true }),
  repo("example-org/admin-console", day(20), { is_private: true }),
  repo("example-org/analytics", day(24), { is_private: true }),
  repo("ada-example/dotfiles", day(30)),
  repo("ada-example/notes", day(41), { is_private: true }),
  repo("partner-org/integration-kit", day(45), { description: "Partner integration samples" }),
  repo("partner-org/webhooks", day(60)),
  repo("example-org/legacy-app", day(200), { is_archived: true }),
  repo("example-org/prototypes", day(220)),
];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function page<T>(all: T[], q: URLSearchParams): { items: T[]; next: string | null } {
  const at = Number(q.get("cursor") ?? 0) || 0;
  const items = all.slice(at, at + PAGE);
  return { items, next: at + PAGE < all.length ? String(at + PAGE) : null };
}

/** Handles /v1/connections/{id}/slack/channels and /v1/connections/{id}/github/repos. */
export function sourceBrowseRoute(req: Request, p: string[], q: URLSearchParams): Response | null {
  if (p[1] !== "connections" || req.method !== "GET" || p.length !== 5) return null;
  const search = (q.get("search") ?? "").trim().toLowerCase();
  if (p[3] === "slack" && p[4] === "channels") {
    if (search === "ratelimit") return json(429, { detail: "Slack is busy: try again in 30 seconds" }, { "Retry-After": "30" });
    const needle = search.replace(/^#/, "");
    const archived = q.get("include_archived") === "true";
    const all = CHANNELS.filter((c) => (archived || !c.is_archived) && c.name.includes(needle));
    const { items, next } = page(all, q);
    return json(200, { channels: items, next_cursor: next });
  }
  if (p[3] === "github" && p[4] === "repos") {
    if (search === "ratelimit") return json(429, { detail: "GitHub is busy: try again in 60 seconds" }, { "Retry-After": "60" });
    const all = REPOS.filter((r) => `${r.full_name} ${r.description ?? ""}`.toLowerCase().includes(search));
    const { items, next } = page(all, q);
    return json(200, { repos: items, next_cursor: next });
  }
  return null;
}
