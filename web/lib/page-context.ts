/**
 * ask-page-context: what Ask Oracle's "This page" reads on every route (owner, Nov 3: a run's
 * review was titled "Runs" and Oracle had none of its items).
 *
 * A chat in "This page" starts on the page's subject (lib/screen-subject.tsx) with what the page
 * shows (`view`): a page with a provider of its own says it (usePageView: the items listed and
 * the filters in use); any other page sends its main region's shown text. The API reads the
 * subject itself as well (a document's text, a run's stop, Home's goals, Simple's plan).
 *
 * - `own`: the page's own provider (usePageView) says what it shows.
 * - `shown`: the main region's shown text, with the page's subject if it sets one.
 * - `name-only`: a person's own page (AUD-9): the chat holds the page's name only.
 * - `none`: no Ask Oracle on the page (sign-in, a customer's link, a redirect).
 *
 * e2e/page-context-registry.spec.ts fails when a route under app/ has no entry here.
 */
export type PageContext = { provider: "own" | "shown" | "name-only" | "none"; reads: string };

const shown = (reads: string): PageContext => ({ provider: "shown", reads });
const nameOnly = (reads: string): PageContext => ({ provider: "name-only", reads });
const none = (reads: string): PageContext => ({ provider: "none", reads });

const DOCUMENT = "The document version (the API reads its text) and the page's shown text";

export const PAGE_CONTEXT: Record<string, PageContext> = {
  // Detailed
  "/": none("Opens the person's home: no page of its own"),
  "/home": shown("Goals, tracks and open runs (the API's Home builder) and the page's shown text"),
  "/inbox": nameOnly("A person's own Inbox"),
  "/account": nameOnly("A person's own account"),
  "/ground-truth": shown("The Ground Truth's goals and entities as shown"),
  "/briefs/[id]": shown("The brief as shown"),
  "/intakes/[id]": shown("The intake as shown"),
  "/company": shown("The company page as shown"),
  "/company/decisions": shown("The decisions as listed"),
  "/company/market": shown("The market page as shown"),
  "/company/metrics": shown("The metrics as shown"),
  "/company/rituals": shown("The rituals as listed"),
  "/company/rituals/[occurrence]": shown("The ritual's occurrence as shown"),
  "/company/strategy": shown("The strategy as shown"),
  "/company/updates": shown("The updates as listed"),
  "/design": shown("The design system page as shown"),
  "/documents": shown("The PRDs (the API's list) and the page's shown text"),
  "/documents/new": shown("The new document form as shown"),
  "/documents/[doc]": shown(DOCUMENT),
  "/documents/[doc]/composition": shown("The document's composition as shown"),
  "/documents/[doc]/diff": shown(DOCUMENT),
  "/documents/[doc]/public": shown("The document's public page as shown"),
  "/documents/[doc]/publish": shown(DOCUMENT),
  "/documents/[doc]/v/[n]": shown(DOCUMENT),
  "/documents/[doc]/v/[n]/evidence": shown("The version's evidence as listed"),
  "/documents/[doc]/v/[n]/impact": shown("The version's impact as shown"),
  "/documents/[doc]/v/[n]/items": shown("The version's roadmap items as listed"),
  "/documents/[doc]/v/[n]/present": shown("The version as presented"),
  "/documents/[doc]/v/[n]/quality": shown(DOCUMENT),
  "/documents/[doc]/v/[n]/roadmap": shown("The version's roadmap as shown"),
  "/impact/changes/[id]": shown("The change's impact as shown"),
  "/impact/entities/[id]": shown("The entity's impact as shown"),
  "/plan": shown("The plan as shown"),
  "/plan/dates": shown("The plan's dates as shown"),
  "/plan/documents": shown("The plan's documents as listed"),
  "/plan/outcomes": shown("The plan's outcomes as shown"),
  "/plan/reports": shown("The reports as listed"),
  "/plan/reports/[id]": shown("The report as shown"),
  "/plan/reports/latest": shown("The latest report as shown"),
  "/priorities": shown("The priority order (its subject) and the page's shown text"),
  "/requests": shown("The requests as listed"),
  "/requests/interviews": shown("The interviews as listed"),
  "/requests/interviews/[id]": shown("The interview as shown"),
  "/requests/new": none("Goes on to Requests or To decide"),
  "/requests/themes": shown("The themes as listed"),
  "/requests/to-decide": shown("The requests to decide as listed"),
  "/roadmap/changelog": shown("The changelog as listed"),
  "/roadmap/launches": shown("The launches as listed"),
  "/runs": shown("The open runs (the API's list) and the page's shown text"),
  "/runs/[id]": shown("The run's waiting stop (its subject: the run, its flow and the stop) and the page's shown text"),
  "/runs/[id]/review/[checkpoint]": {
    provider: "own",
    reads:
      "The run, its flow and the stop (its subject); on Roadmap items, the items listed with horizon, milestone and date, confidence and why each needs you, and the filters in use (ItemsReview's usePageView); other stops: the page's shown text",
  },
  "/sources": nameOnly("A person's own sources"),
  "/specs/[id]/design/[versionId]": shown("The spec's design version as shown"),
  "/settings": nameOnly("Settings are a person's or an owner's own"),
  "/settings/analytics": nameOnly("Settings are a person's or an owner's own"),
  "/settings/api-tokens": nameOnly("Settings are a person's or an owner's own"),
  "/settings/autonomy": nameOnly("Settings are a person's or an owner's own"),
  "/settings/claude-accounts": nameOnly("Settings are a person's or an owner's own"),
  "/settings/company": nameOnly("Settings are a person's or an owner's own"),
  "/settings/connections": nameOnly("Settings are a person's or an owner's own"),
  "/settings/members": nameOnly("Settings are a person's or an owner's own"),
  "/settings/notifications": nameOnly("Settings are a person's or an owner's own"),
  "/settings/sources": nameOnly("Settings are a person's or an owner's own"),
  "/settings/templates": nameOnly("Settings are a person's or an owner's own"),
  "/settings/templates/[key]": nameOnly("Settings are a person's or an owner's own"),
  "/settings/templates/new": nameOnly("Settings are a person's or an owner's own"),
  "/settings/themes": nameOnly("Settings are a person's or an owner's own"),
  "/settings/themes/[key]": nameOnly("Settings are a person's or an owner's own"),
  "/settings/themes/new": nameOnly("Settings are a person's or an owner's own"),
  "/settings/trash": nameOnly("Settings are a person's or an owner's own"),
  "/settings/webhooks": nameOnly("Settings are a person's or an owner's own"),
  // Simple: the API reads the company's plan first on every Simple page
  "/simple": shown("The plan and the page's shown text"),
  "/simple/decisions": shown("The plan and the decisions as listed"),
  "/simple/goals": shown("The plan and the goal map as shown"),
  "/simple/meetings": shown("The plan and the meetings as listed"),
  "/simple/meetings/[id]": shown("The plan and the meeting as shown"),
  "/simple/meetings/[id]/chat": shown("The plan and the meeting's chat as shown"),
  "/simple/one-pagers": shown("The plan and the one-pagers as listed"),
  "/simple/one-pagers/[doc]": shown("The plan and the one-pager as shown"),
  "/simple/prds/[doc]": none("Goes on to the one-pager"),
  "/simple/priorities": shown("The plan and the priorities as shown"),
  "/simple/roadmap": shown("The plan, the open card's item (its subject) and the roadmap as shown"),
  // Without the shell: no Ask Oracle
  "/login": none("Sign-in"),
  "/access": none("Waiting to join"),
  "/oauth/consent": none("A client's consent"),
  "/i/[token]": none("A customer's interview link"),
  "/s/[token]": none("A shared roadmap link"),
};

/**
 * A person's own pages (AUD-9: sources, settings, the Inbox, the account): their chat holds the
 * page's name only, as the API's screen context does.
 */
export function pageNameOnly(path: string): boolean {
  return /^\/(sources|settings|inbox|account)(\/|$)/.test(path.split("?")[0]);
}
