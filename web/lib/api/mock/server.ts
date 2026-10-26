/**
 * In-browser stand-in for the API, used when NEXT_PUBLIC_API_MOCKS=1. It is plugged
 * into openapi-fetch as its `fetch`, so pages call the typed client exactly as they
 * will against the real API. State lives in localStorage, so it survives reloads.
 */
import type { Schemas } from "@/lib/api/client";
import { addMonths, todayIn } from "@/lib/dates";
import { sectionDiff } from "@/lib/diff";
import { plainText } from "@/lib/markdown";
import { displayName } from "@/lib/names";

import { mockUuid, seeded } from "./ids";
import { addGoalCodes, addGoalWords, addNoisyProposals, addOverlappingProposals, attributeCommenterProposal, attributeGoalOwner, attributeLocks, enlargeBaseline, routeBaseline, seedBaseline, setEntityEffort, type BaselineState } from "./baseline";
import { documentGate, routeBlockers, seedBlockers, type BlockersDb } from "./blockers";
import { CODED_PRD } from "./named-codes";
import { BIG_PRD, BIG_PRD_COMMENTS, BIG_PRD_REVIEWS, BIG_PRD_SUGGESTIONS } from "./big-prd";
import { applied, handOver, membersDetailRoute, type MembersContext, type MembersDb } from "./members";
import type { HandOver } from "@/lib/api/members-types";
import { accountRoute, liveCredentials, openTokens, passwordOk, revokeMemberTokens, seedAccount, type AccountDb } from "./account";
import { deckOut, LAYER_FORMATS, PPTX_TYPE, presenterNotes, resolveBrief } from "./brief";
import { capabilitiesOut } from "./capabilities";
import { POOL_SPENT_SCENARIO, claudeAccountsRoute, poolRefusal } from "./claude-accounts";
import { connectionsRoute, mockSettingValue, setupFacts } from "./connections";
import { decidePricing, decisionInbox, enlargeDecisions, proposePricing, requestDecisions, routeDecisions, seedDecisions, type DecisionsContext, type DecisionsDb } from "./decisions";
import { routeStaging } from "./staging";
import { afterAccept, goalInterviewReply, routeGoalInterview, type GoalInterviewContext } from "./goal-interview";
import { goalCheck } from "./goals";
import {
  discussionInboxRows,
  emptyDiscussions,
  routeDiscussions,
  seedDiscussionInbox,
  seedDiscussionReplies,
  seedDiscussions,
  seedDiscussionRecord,
  seedRunDiscussions,
  type DiscussionRow,
  type DiscussionsContext,
  type DiscussionsDb,
  type DocumentSection,
  type SubjectInfo,
} from "./discussions";
import { routeEngineering, type CodeMapRow } from "./engineering";
import { DOCUMENTS, FLEET_DOC, FLEET_SUGGESTIONS, MOCK_ACCESS_REQUESTS, MOCK_INVITES, MOCK_LOGIN, MOCK_MEMBERS, REMOVED_MEMBER, roadmapFromPrd, UPDATE_DOCUMENTS, UPDATE_SEED_CITATIONS, type DocumentSeed, type VersionSeed } from "./fixtures";
import { laneF, nothingWritten, NOTHING_WRITTEN, type LaneFState } from "./lane-f";
import { llmJobsRoute, onFeedback, seedLlm, tick, withSuggestion, type LlmContext, type LlmDb } from "./llm-jobs";
import { inboxStates, isStaged } from "./next-draft";
import { emptyAutonomy, inboxActions, levelFor, routeAutonomy, seedLaunchDid, seedOracleDid, seedRitualDid, type AutonomyDb } from "./autonomy";
import { routeModules, seedModules, type ModulesDb } from "./modules";
import { baselineReviewOf, fromRun, seedFromRun } from "./from-run";
import {
  approveRunReview,
  ENGINEERING_KINDS,
  enlargeRuns,
  FEATURE_SET_RUN,
  fromRunCheckpoint,
  lastBaselineBuild,
  reviewedVersion,
  ROADMAP_REVIEW_HELD_RUN,
  routeRuns,
  seedEngCheckRun,
  seedBaselineReviewRun,
  seedEngReviewRun,
  seedFeatureSetRun,
  seedPriorityRuns,
  seedRunReviewRun,
  seedRuns,
  seedScopeReviewRuns,
  sendBackEntries,
  type RunsContext,
  type RunsDb,
} from "./runs";
import { personRequirements, scopeJobRoute, type StoredScope } from "./scope";
import { routeFirefliesBrowse } from "./fireflies";
import { sourceBrowseRoute } from "./source-browse";
import { routeSources, sourceCount, sourceItem, SOURCES_STORAGE_KEY } from "./sources";
import { BEFORE_DRAFTING, LATE_ANSWER_WITHHELD, routeIntake, seedBeforeDrafting, seedBriefGoalRejected, startedIntakeRun, type SubjectLookup } from "./intake";
import { ensureReports, inboxReports, reportsRoute, type ReportsDb } from "./reports";
import { discussionSlackRoute, failSlackMirror, holdSlackMirror, injectSlackReply, seedSlackBridge, SLACK_SCENARIO, slackRoute } from "./slack";
import { addDigest, addMetricsReview, ritualInbox, routeRituals, seedRituals, type RitualsContext, type RitualsDb } from "./rituals";
import { emptyMetrics, metricInbox, openVariances, reviewBlocks, routeMetrics, seedMetrics, type MetricsContext, type MetricsDb } from "./metrics";
import { digestBlocks, emptyMarket, routeMarket, seedMarket, type MarketDb } from "./market";
import { addInterviewRequest, requestInboxRows, routeRequests, seedRequests, seedWhyNot, WHY_NOT_SCENARIO, type RequestsContext, type RequestsDb } from "./requests";
import { MOCK_COMPANY, routeInterviews, routePublicInterviews, routeTeamInterviews, seedInterviews, type InterviewsContext, type InterviewsDb } from "./interviews";
import { launchInboxRows, routeLaunches, seedLaunches, type LaunchesContext, type LaunchesDb } from "./launches";
import {
  calibration,
  outcomeInboxRows,
  publishRefusal,
  routeQuality,
  seedLearnings,
  seedOracleRecorded,
  seedOutcomes,
  seedQuality,
  type QualityContext,
  type QualityDb,
} from "./quality";
import { routeReviewV2, sectionRevision, seedReviewV2, type ReviewV2Db } from "./review-v2";
import { emptyPlanEdits, routeChangeSets, supersededRefusal, type PlanEditsContext, type PlanEditsDb } from "./plan-edits";
import { draftRoadmapSummary, queueDraftRoadmap, reusableDraftItems, routeDraftRoadmap, seedApprovedPlanDraft, seedDraftRoadmaps, tickDraftRoadmaps, type DraftRoadmapContext, type DraftRoadmapDb } from "./draft-roadmap";
import { ALERTS_ROADMAP_SLUG, APPROVED_PLAN_SCENARIO, DATE_BASES_SCENARIO, DIFF_SCENARIO, VERSION_WARNINGS_SCENARIO, dateMarks, versionWarnings, inboxTracks, routePlan, routeRoadmap, seedRoadmap, seededPlanItems, trackRunBody, type RoadmapContext, type RoadmapDb } from "./roadmap";
import { routeSpecs, seedSpecs, specStalenessAction, specStates, staleSpecRefusal, type SpecsDb } from "./specs";
import { inboxStrategy, routeStrategy, seedNoStrategy, seedStrategy, STRATEGY_DOCUMENTS, type StrategyDb } from "./strategy";
import { routeTrace } from "./trace";
import {
  DRAFT_OPTIONS,
  memoOptions,
  PRICING_TEMPLATE,
  pricingDraftSections,
  pricingFrontMatter,
  pricingTemplateSections,
  routeDeals,
  seedDeals,
  type EvidenceWindow,
  type PricingContext,
  type PricingDb,
} from "./pricing";
import { canSee, draftSections, isUpdateTemplate, periodMonth, templateSections, updateDateMarks, updateFrontMatter, type UpdatePeriod } from "./updates";
import { emptyTrash, routeTrash, type TrashDb } from "./trash";
import { emptyV2, routeV2, seedV2, type V2Db } from "./v2";

/**
 * latest_version, approved_version, source and an update's period are read off the versions;
 * visibility is "company" unless the row says otherwise (H8: updates are "approvers").
 */
export type DocumentRow = Omit<Schemas["DocumentSummary"], "latest_version" | "approved_version" | "source" | "visibility" | "period"> & {
  visibility?: Schemas["DocumentSummary"]["visibility"];
};
export type VersionRow = Omit<Schemas["VersionOut"], "sections" | "date_marks"> & {
  sections: (Omit<Schemas["SectionOut"], "verdict" | "spec_states"> & Partial<Pick<Schemas["SectionOut"], "spec_states">>)[];
};
type CommentRow = Omit<Schemas["CommentOut"], "replies">;
/** A stored section review; a spec may mark an approval lapsed (C2). */
type ReviewRow = Schemas["SectionReviewOut"] & { lapsed_at?: string | null; lapse_reason?: string | null };
/** Stored without its derived C1e state (withSuggestion adds it on the way out). */
type FeedbackRow = Omit<Schemas["FeedbackItemOut"], "state" | "staged_for_version" | "staged_for_agents"> & {
  /** D12: staged for the agents (when, by whom); open items only count. */
  staged_for_agents_at?: string | null;
  staged_for_agents_by?: string | null;
};
type MemberRow = Schemas["MemberOut"];
type InviteRow = Schemas["InviteOut"];
type Role = MemberRow["role"];

export interface Db {
  /** Email of the signed-in mock member (the last sign-in in any tab). */
  session: string | null;
  /** D8: each tab's own sign-in, by the tab's id (sessionStorage). */
  tab_sessions?: Record<string, string>;
  tenant_id: string;
  /** The seed owner (admin@example.com): author of the seeded comments and verdicts. */
  user_id: string;
  members: MemberRow[];
  invites: InviteRow[];
  /** A5: access requests (Settings › Members). */
  access_requests?: Schemas["AccessRequestOut"][];
  /** A5: the note the pending person sent with their request (the access-pending scenario). */
  access_note?: string | null;
  /** A5: what each member holds (responsibilities, approvals), seeded in ./members.ts. */
  holdings?: MembersDb["holdings"];
  /** Invites an owner resent (the "mail-fails" scenario sends those). */
  invites_resent?: string[];
  documents: DocumentRow[];
  versions: VersionRow[];
  comments: CommentRow[];
  reviews: ReviewRow[];
  feedback: FeedbackRow[];
  baseline: BaselineState;
  /** Priorities, templates, themes and draft defaults (lane-f.ts), seeded on first use. */
  lane_f?: LaneFState;
  /** Runs, checkpoints and their artifacts (./runs.ts); absent in data saved before runs existed. */
  runs?: RunsDb;
  /** D12: the agents' run estimate in the "next-draft-costly" scenario. */
  next_draft_run_usd?: number;
  /** Built-in model jobs and suggestions (./llm-jobs.ts); absent in older saved data. */
  llm?: LlmDb;
  /** Product Oracle v2 tables (./v2.ts); absent in data saved before v2. */
  v2?: V2Db;
  /** #482: Trash (./trash.ts); absent in data saved before it. */
  trash?: TrashDb;
  /** v2 review state, campaigns, notifications, publications (./review-v2.ts). */
  review_v2?: ReviewV2Db;
  /** Outcome records and learnings (./quality.ts); absent in data saved before CR-08. */
  quality?: QualityDb;
  /** Module catalogue and compositions (./modules.ts); absent in older saved data. */
  modules?: ModulesDb;
  /** Blocker strategies (./blockers.ts) on the v2 rows; absent in older saved data. */
  blockers?: BlockersDb;
  /** C1e: each member's last Inbox visit (what "new" is measured from), by member id. */
  inbox_seen?: Record<string, string>;
  /** E1: every PRD draft's items-only roadmap (./draft-roadmap.ts); seeded on first use. */
  draft_roadmaps?: DraftRoadmapDb;
  /** Roadmap items, product tracks, schedule bases and tracker records (./roadmap.ts, CR-11). */
  roadmap?: RoadmapDb;
  /** #346: roadmap change sets and the versions they proposed (./plan-edits.ts). */
  plan_edits?: PlanEditsDb;
  /** Specs, flows and wireframes (./specs.ts); absent in data saved before CR-09. */
  specs?: SpecsDb;
  /** F5-2 code maps (./engineering.ts); absent in older saved data. */
  code_maps?: CodeMapRow[];
  /** Requests, their themes and the found items of the seed owner (./requests.ts, C1). */
  requests?: RequestsDb;
  /** C3 customer interviews (./interviews.ts); the fixture's link is `i-mock-token`. */
  interviews?: InterviewsDb;
  /** The decision log (./decisions.ts, H1); absent in data saved before it. */
  decisions?: DecisionsDb;
  /** Rituals, their occurrences and the summaries mode (./rituals.ts, H2); seeded on first use. */
  rituals?: RitualsDb;
  /** H5: metrics, their weekly values and variances, and the PostHog connection (./metrics.ts); seeded in the "metrics" scenario only. */
  metrics?: MetricsDb;
  /** Launches, their checklist and notes, and the changelog (./launches.ts, H6). */
  launches?: LaunchesDb;
  /** H9: win and loss records (./pricing.ts); seeded in the "pricing" scenario only. */
  pricing?: PricingDb;
  /** Alternatives, watched pages, the change log, web findings and positioning (./market.ts, H7). */
  market?: MarketDb;
  /** Per-user preferences (O1f document_view), by member email. */
  preferences?: Record<string, Schemas["Preferences"]>;
  /** Provider revokes a removed member's disable could not make (C2); seeded in the
   * "revoke-failures" scenario only. */
  revoke_failures?: RevokeFailureRow[];
  /** Access changes still failing after 24 hours (#245); seeded in the "access-failures"
   * scenario only. A retry succeeds. */
  access_failures?: Schemas["InboxAccessFailure"][];
  /** Alignment reports, their reads and Oracle's Slack install (./reports.ts, F6); seeded in
   * the "alignment-report" scenario only. */
  reports?: ReportsDb;
  /** H4: drift findings and the strategy stack (./strategy.ts); the "strategy" scenario only. */
  strategy?: StrategyDb;
  /** H11: the owner's autonomy levels and the "Oracle did" rows (./autonomy.ts); absent in older saved data. */
  autonomy?: AutonomyDb;
  /** Every credential by kind, changed passwords (./account.ts); seeded on first use. */
  account?: AccountDb;
  /** Discussions (./discussions.ts, G1); seeded in the "discussions" scenario only. */
  discussions?: DiscussionsDb;
}

type RevokeFailureRow = Schemas["InboxRevokeFailure"] & { dismissed?: boolean };

/** Two revokes still owed: GitHub (24 hours of retries over) and Slack (not configured, still retried). */
function seedRevokeFailures(): RevokeFailureRow[] {
  const member = { member_id: uuid(), member_email: "former.pm@example.com" };
  const item = (provider: string, name: string, extra: Partial<RevokeFailureRow>): RevokeFailureRow => ({
    id: uuid(),
    ...member,
    provider,
    provider_name: name,
    title: `Couldn't revoke ${member.member_email}'s ${name} access at ${name}`,
    status: "pending",
    outcome: "failed",
    last_error: null,
    attempts: 1,
    created_at: "2026-10-18T09:00:00Z",
    next_attempt_at: null,
    retry_until: "2026-10-19T09:00:00Z",
    ...extra,
  });
  return [
    item("github", "GitHub", { status: "failed", attempts: 12, last_error: "the provider did not answer in time" }),
    item("slack", "Slack", {
      outcome: "not_configured",
      attempts: 3,
      created_at: "2026-10-19T20:00:00Z",
      next_attempt_at: "2026-10-19T20:30:00Z",
      retry_until: "2026-10-20T20:00:00Z",
    }),
  ];
}

/** A revoked invite's access removal, refused by Google for over 24 hours (#245). */
function seedAccessFailures(): Schemas["InboxAccessFailure"][] {
  return [
    {
      id: uuid(),
      kind: "iap_revoke",
      email: "jo.tester@example.com",
      owed: "Access not removed",
      last_error: "Google returned 403 (permission denied)",
      attempts: 27,
      created_at: "2026-10-18T09:00:00Z",
      next_attempt_at: "2026-10-20T09:00:00Z",
    },
  ];
}

/** Retry and Dismiss of a revoke a disable owes: owners only, as in the API. A retry succeeds,
 * except while the provider's OAuth app is not configured. An access change's Retry (#245)
 * succeeds, and its item closes. */
function followUpsRoute(db: Db, req: Request, p: string[], me: MemberRow): Response | null {
  if (p[1] !== "member-follow-ups" || req.method !== "POST") return null;
  if (!atLeast(me.role, "owner")) return forbidden("owner");
  const access = (db.access_failures ??= []).find((r) => r.id === p[2]);
  if (access && p[3] === "retry") {
    db.access_failures = db.access_failures.filter((r) => r.id !== access.id);
    return json(200, {
      id: access.id,
      member_id: access.id,
      kind: access.kind,
      email: access.email,
      status: "done",
      attempts: access.attempts + 1,
      outcome: access.kind === "iap_revoke" ? "removed" : "granted",
      last_error: null,
      created_at: access.created_at,
      next_attempt_at: null,
      done_at: now(),
    });
  }
  db.revoke_failures ??= [];
  const row = db.revoke_failures.find((r) => r.id === p[2]);
  if (!row) return notFound("Follow-up");
  if (row.dismissed) return json(409, { detail: "This follow-up is dismissed; nothing to do" });
  const out = (status: string) => ({
    id: row.id,
    member_id: row.member_id,
    kind: "provider_revoke",
    provider: row.provider,
    status,
    attempts: row.attempts,
    outcome: row.outcome,
    last_error: row.last_error,
    created_at: row.created_at,
    next_attempt_at: row.next_attempt_at,
  });
  if (p[3] === "dismiss") {
    row.dismissed = true;
    return json(200, { ...out("dismissed"), dismissed_at: now(), dismissed_by: me.id });
  }
  if (p[3] === "retry") {
    row.attempts += 1;
    if (row.outcome === "not_configured") return json(200, out(row.status));
    db.revoke_failures = db.revoke_failures.filter((r) => r.id !== row.id);
    return json(200, { ...out("done"), outcome: "revoked", last_error: null });
  }
  return notFound("Route");
}

/** The track record over the mock's outcomes (H3), goals named from the baseline. */
export function trackRecord(db: Db): Schemas["CalibrationOut"] {
  const titles = Object.fromEntries(db.baseline.entities.filter((e) => e.type === "goal").map((e) => [e.id, e.title]));
  return calibration(db.quality, titles);
}

/** The launches' context: the signed-in member, the commenter who asked, the first track. */
function launchesContext(db: Db, me: MemberRow): LaunchesContext {
  return {
    userId: me.id,
    role: me.role,
    askerId: db.members.find((x) => x.role === "commenter")?.id ?? null,
    trackId: db.roadmap?.tracks[0]?.id ?? null,
    roadmapItems: (trackId) => {
      const t = db.roadmap?.tracks.find((x) => x.id === trackId);
      if (!t) return null;
      const doc = db.documents.find((d) => d.id === t.roadmap_id);
      const v = db.versions
        .filter((x) => x.document_id === t.roadmap_id && x.approved_at && db.roadmap!.items[x.id]?.length)
        .sort((a, b) => b.number - a.number)[0];
      if (!v) return [];
      return db.roadmap!.items[v.id].map((i) => ({
        item_key: i.item_key, title: i.title, horizon: i.horizon, roadmap_slug: doc?.slug ?? null, roadmap_version: v.number,
      }));
    },
  };
}

function ensureLaunches(db: Db): LaunchesDb {
  db.launches ??= { launches: [], tasks: [], notes: [], changelog: [] };
  return db.launches;
}

const STORAGE_KEY = "po-mock-db-v2";
/** Tests set this localStorage key (viewer, commenter, approver) to act with another role. */
export const MOCK_ROLE_KEY = "po-mock-role";
/**
 * Tests set this localStorage key before signing in, as MOCK_ROLE_KEY, to a comma-separated
 * list of operation ids that GET /v1/me/capabilities answers false (#370: a control is absent
 * when its operation is not allowed, also when the role would allow it).
 */
export const MOCK_DENY_KEY = "po-mock-deny";
/**
 * Tests and screenshots set this localStorage key before the first call: "empty" starts as a
 * new company (members only, no goals, documents, runs or questions); "large" as a big one
 * (30 goals, 50 more active runs, 250 more decisions, questions asked of the signed-in member); "suggestions" as the
 * default company plus a PRD with three open Oracle suggestions (fleet-next); "big-prd" adds a PRD
 * of 100+ sections in nested chapters (platform-handbook, ./big-prd.ts); "revoke-failures" as the
 * default company plus two provider revokes a removed member's disable could not make (C2);
 * "access-failures" as the default company plus a revoked invite whose access removal has kept
 * failing for over 24 hours (#245);
 * "alignment-report" as the default company plus two weekly alignment reports and Oracle's
 * Slack install (./reports.ts, F6);
 * "undelivered" as the default company where SwarmCloud takes no checkpoint decision until the
 * next tick (recorded, the decide call answers 503; ./runs.ts); "slow-agents" as the default
 * company where a segment's agents take two ticks: the first reads them working (#258); "questions" as the default
 * company plus an "Oracle asks" question on an intake with no PRD and an "Approver asks"
 * question on a PRD section, both asked of the signed-in owner, and one delegated to
 * approver@example.com (C2); "private-finding" as "questions" plus a private finding (S6) on
 * the clinic waitlist, its question asked of the signed-in owner, its author; "many-people" as
 * "questions" in a company of 25 members (zoe.zimmer@example.com last by email);
 * "launches" as the default company plus three launches (Ready, Planned, Launched) with their
 * checklists, notes and changelog entries (./launches.ts);
 * "oracle-did" as the default company plus one thing Oracle did on its own, told to the
 * signed-in owner (./autonomy.ts);
 * "rituals" as the default company plus a Monthly roadmap refresh pre-read prepared early
 * (the owner and the approver attend) and last week's goals check-in, held, whose summary
 * failed (H2, ./rituals.ts);
 * "market" as the default company plus three made-up alternatives with a page change, three
 * not-vetted web findings and two positioning suggestions, and the Monthly competitive
 * digest's pre-read prepared early (H7, ./market.ts);
 * "roadmap-items" as the default
 * company whose usage-alerts-roadmap v1 items carry every field the Items tab shows (E2,
 * ./roadmap-items.json); "roadmap-diff" as the default company plus usage-alerts-roadmap v2,
 * a draft whose items moved, added and dropped one each since the approved v1 (E3);
 * "approved-plan" as the default company plus usage-alerts-roadmap v1 approved and usage-alerts
 * v2, a draft with a new "3. Spend limits" section whose ready draft items move Behaviour from
 * Now to Next, keep Success metrics and add Spend limits (Now) (E3b);
 * "feature-set" as the default company plus a run waiting at a feature set with a blocking
 * problem (C6, saved-addresses);
 * "scope-review" as the default company plus three runs at their feature set (C7: attempt 1
 * with three rows that need a person, attempt 2, and a held console approval);
 * "before-drafting" as the default company plus a brief by the signed-in owner with two batches
 * of Oracle's questions (C5, ./intake.ts seedBeforeDrafting);
 * "late-answers" as "before-drafting" with that brief drafting into Checkout redesign: an answer
 * given now becomes a feedback item on the PRD (C5 late answers); its success-metric gap is a
 * finding shared in full;
 * "brief-goal-rejected" as the default company plus a brief by the approver serving Raise
 * activation and Cut early churn, a goal rejected since (#260, ./intake.ts seedBriefGoalRejected);
 * "run-discussions" as "feature-set" plus an open discussion and a private one (the approver's,
 * with the owner) on that run's waiting checkpoint (G5, ./discussions.ts seedRunDiscussions);
 * "discussions" as the default company plus one private discussion the commenter started
 * with the approver on team-workspaces v2's Problem, 3 messages from the 2 of them (G1,
 * ./discussions.ts);
 * "mail-off" as the default company with no invite sender configured (invites are not
 * emailed); "mail-fails" where every first invite email fails (Resend sends it);
 * "iap-pending" where an invite's Google IAP access is not granted until Retry (#242; a plus
 * address never gets it, in any scenario: Google answers 400, #330);
 * "iap-revoke-fails" where removing a member leaves their Google IAP access to remove (the
 * tick retries it);
 * "read-only-credential" where My account is read through an oracle:read personal token
 * (AC1: it changes nothing, the name included).
 */
export const MOCK_SCENARIO_KEY = "po-mock-scenario";
/** Tests set this localStorage key to a path ("/v1/questions") to make its GETs fail with a 500. */
export const MOCK_FAIL_KEY = "po-mock-fail";
/** Tests set this localStorage key to "METHOD /path" to make that call's next request fail once with a 500. */
export const MOCK_FAIL_ONCE_KEY = "po-mock-fail-once";
/** Tests set this localStorage key to a path ("/v1/decisions/5") to make its GETs answer late, after calls made later. */
export const MOCK_SLOW_KEY = "po-mock-slow";
export const MOCK_SLOW_MS = 1500;
/**
 * D8: tests set this localStorage key to a member's email to have them change a checkpoint's
 * shared draft after the page loaded it: the next decide bumps the draft's revision by one
 * change of theirs (then refuses a decision sent with the older one). Read once.
 */
export const MOCK_REVIEW_CHANGE_KEY = "po-mock-review-change";
/**
 * Each tab keeps its own sign-in (D8): the mock's data is one browser context's localStorage,
 * so a second reviewer is a second tab of it signed in as someone else. A tab's id lives in
 * its sessionStorage, its sign-in in the data (clearing the data signs every tab out).
 */
const TAB_ID_KEY = "po-mock-tab";

function tabId(): string {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

/** The signed-in member's email: this tab's sign-in, else the last one in any tab. */
function sessionOf(db: Db): string | null {
  return db.tab_sessions?.[tabId()] ?? db.session;
}

function setSession(db: Db, email: string | null) {
  db.session = email;
  db.tab_sessions ??= {};
  if (email) db.tab_sessions[tabId()] = email;
  else delete db.tab_sessions[tabId()];
}
const ROLES: readonly Schemas["Me"]["role"][] = ["viewer", "commenter", "approver", "owner"];

/** The signed-in member, with the role overridden when a test set MOCK_ROLE_KEY. */
function withMockRole<T extends { role: Schemas["Me"]["role"] }>(member: T): T {
  const role = localStorage.getItem(MOCK_ROLE_KEY) as Schemas["Me"]["role"] | null;
  return role && ROLES.includes(role) ? { ...member, role } : member;
}
const LATENCY_MS = 60;

const uuid = mockUuid;

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const now = () => new Date().toISOString();

/** The seeded API token that imports the mock's versions unless a seed says who did. */
const AGENT_TRACK = { id: "3d7e9a52-6b14-4c8f-a0e2-71f5c9b8d046", name: "agent-track" };

function buildVersion(doc: DocumentRow, seed: VersionSeed): VersionRow {
  const id = uuid();
  const layered = resolveBrief(seed.sections.map((s) => ({ section_key: s.key, level: s.level })), seed.brief);
  const depth = (DOCUMENTS as DocumentSeed[]).find((d) => d.slug === doc.slug)?.depth ?? "full";
  const sections = seed.sections.map((s, ordinal) => ({
    id: uuid(),
    section_key: s.key,
    ordinal,
    level: s.level,
    heading: s.heading,
    body_md: s.body,
    body_text: plainText(s.body),
    content_hash: hash(s.heading + "\n" + s.body),
    citation_keys: [...new Set([...s.body.matchAll(/\[c:([\w.:-]+)\]/g)].map((m) => m[1]))],
    layer: layered.brief.has(s.key) ? ("brief" as const) : ("detail" as const),
    notes: layered.brief.has(s.key) ? presenterNotes(s.body) : null,
    spec_states: doc.kind === "spec" ? specStates(s.key, s.body, false, depth) : [],
  }));
  return {
    id,
    brief_source: layered.brief_source,
    document_id: doc.id,
    number: seed.number,
    content_hash: hash(sections.map((s) => s.content_hash).join("")),
    snapshot: seed.snapshot ?? null,
    warnings: [],
    notes: [],
    imported_by: (seed.by ?? AGENT_TRACK).id,
    imported_by_name: (seed.by ?? AGENT_TRACK).name,
    approved_at: null,
    approval_lapses: [],
    created_at: seed.created_at,
    front_matter: { document: doc.slug, title: doc.title, template: doc.template ?? undefined },
    sections,
    citations: seed.citations.map((c) => ({
      id: uuid(),
      cite_key: c.id,
      source: c.source,
      ref: c.ref,
      title: c.title,
      excerpt: c.excerpt,
      retrieved_at: c.retrieved_at,
      added: c.added ?? false,
      state_label: c.state_label ?? null,
      // A mock company has no source items: the writer's item id shows as given.
      item_id: c.item ?? null,
      confidence: c.confidence ?? null,
      confidence_note: c.confidence_note ?? null,
      low_confidence: c.low_confidence ?? false,
    })),
  };
}

/** A new company: the members and their invites, nothing else yet. */
function seedEmpty(): Db {
  const db: Db = {
    session: null,
    tenant_id: uuid(),
    user_id: uuid(),
    members: [],
    invites: [],
    // A5: nobody has asked to join a new company yet.
    access_requests: [],
    documents: [],
    versions: [],
    comments: [],
    reviews: [],
    feedback: [],
    baseline: { entities: [], edges: [], evidence: [], conflicts: [], proposals: [], revisions: [] },
    runs: { runs: [], artifacts: {} },
    v2: emptyV2(),
  };
  db.members = MOCK_MEMBERS.map((m) => ({
    ...m,
    id: m.email === MOCK_LOGIN.email ? db.user_id : uuid(),
    disabled_at: null,
    disabled_by: null,
    status: "active" as const,
    open_tokens: 0,
  }));
  return db;
}

/** A big company: Home must stay within a fixed number of calls however much there is. */
function seedLarge(): Db {
  const db = seed();
  enlargeBaseline(db.baseline, uuid, 27);
  db.runs = seeded("runs", () => seedRuns(runsContext(db)));
  enlargeRuns(db.runs, uuid, 50);
  const v2 = ensureV2(db);
  const model = v2.questions[0];
  for (let i = 1; i <= 4; i++) {
    const at = new Date(Date.parse(model.created_at) + i * 60_000).toISOString();
    v2.questions.push({ ...model, id: uuid(), prompt: `Which clinics open first in region ${i}?`, priority: 10 + i, created_at: at, updated_at: at });
  }
  // Asked of someone else: not the signed-in member's to answer.
  const other = db.members.find((m) => m.id !== db.user_id)!;
  v2.questions.push({ ...model, id: uuid(), prompt: "Who owns the pricing page?", asked_to: other.id, created_at: model.created_at, updated_at: model.created_at });
  return db;
}

/** The default company plus questions to people (C2): see MOCK_SCENARIO_KEY. */
function seedQuestions(): Db {
  const db = seed();
  const v2 = ensureV2(db);
  const approver = db.members.find((m) => m.email === "approver@example.com")!;
  const prd = db.documents.find((d) => d.slug === "checkout-redesign")!;
  const at = (iso: string) => ({ created_at: iso, updated_at: iso });
  const intake = uuid();
  const gap = uuid();
  v2.intakes.push({
    id: intake, title: "Clinic waitlist", brief: "Patients wait by phone for a cancelled slot. Let them join a waitlist instead.",
    author_id: db.user_id, source_snapshot_ids: [], status: "awaiting_answers", document_id: null, lock_version: 1,
    analysis: { users: [], problem: null, outcomes: [], goal_ids: [], scope: ["A waitlist for cancelled slots"], non_goals: [], dependencies: [], blockers: [], category: "feature", conflicts: [] },
    ...at("2026-10-01T09:00:00Z"),
  });
  v2.gaps.push({
    id: gap, intake_id: intake, document_id: null, category: "customer_user", statement: "Customer and user: not known yet.",
    impact: ["goals", "scope", "module_selection"], importance: "high", evidence_ids: [], confidence: null, knowledge_state: "unknown",
    status: "asked", owner_id: null, related_modules: ["context.users"], stop_condition: null, entity_ids: [], section_keys: [],
    created_by: null, lock_version: 1, ...at("2026-10-01T09:00:00Z"),
  });
  const base = { checkpoint_id: null, item_ref: null, entity_id: null, module_key: null, batch: null, priority: 100 };
  v2.questions.push(
    {
      ...base, id: uuid(), gap_id: gap, intake_id: intake, document_id: null, category: "customer_user",
      prompt: "Which clinics join the waitlist first?", rationale: "Decides who the first release is for, and its scope.",
      batch: 1, priority: 10, asked_to: db.user_id, asked_by: db.user_id, section_key: null, status: "asked", ...at("2026-10-01T09:00:00Z"),
    },
    {
      ...base, id: uuid(), gap_id: null, intake_id: null, document_id: prd.id, category: "general",
      prompt: "Which plan tiers get hard caps?", rationale: "The scope review needs it before approving.",
      asked_to: db.user_id, asked_by: approver.id, section_key: "metrics", status: "asked", ...at("2026-10-18T09:00:00Z"),
    },
    {
      ...base, id: uuid(), gap_id: null, intake_id: null, document_id: prd.id, category: "general",
      prompt: "Who signs off the refund rule?", rationale: null,
      asked_to: approver.id, asked_by: db.user_id, section_key: "metrics", status: "delegated", ...at("2026-10-18T10:00:00Z"),
    },
  );
  return db;
}

/** The default company plus a brief before drafting (C5): see MOCK_SCENARIO_KEY. */
function seedBeforeDraftingScenario(): Db {
  const db = seed();
  const approver = db.members.find((m) => m.email === "approver@example.com")!;
  seedBeforeDrafting(ensureV2(db), db.user_id, approver.id);
  return db;
}

/**
 * C5 late answers: the "before-drafting" brief, drafting since 22 Oct into the Checkout
 * redesign PRD; the answers given by then are the draft run's, the questions still asked
 * (Pain evidence of the approver, Success metric and Goal alignment of the owner) are not.
 */
function seedLateAnswersScenario(): Db {
  const db = seedBeforeDraftingScenario();
  const v2 = ensureV2(db);
  const intake = v2.intakes.find((i) => i.id === BEFORE_DRAFTING.intakeId)!;
  const prd = db.documents.find((d) => d.slug === "checkout-redesign")!;
  Object.assign(intake, { status: "converted", document_id: prd.id });
  const mine = new Set(v2.questions.filter((x) => x.intake_id === intake.id).map((x) => x.id));
  v2.intake_runs = {
    ...v2.intake_runs,
    [intake.id]: { run_id: "c5000000-0000-4000-8000-0000000000d1", answer_ids: v2.answers.filter((a) => mine.has(a.question_id)).map((a) => a.id), document: prd.slug },
  };
  // The owner's success-metric gap is also a finding from their own sources, shared in full:
  // an answer to it is quoted in feedback only while it stays shared from summary up (S6).
  const metric = v2.gaps.find((g) => g.intake_id === intake.id && g.category === "success_metric")!;
  v2.intake_findings = {
    ...v2.intake_findings,
    [intake.id]: [
      ...(v2.intake_findings?.[intake.id] ?? []),
      {
        id: "c5000000-0000-4000-8000-0000000000f1", kind: "gap", origin: "rules", category: "success_metric", sharing: "full",
        summary: "A gap about success metric", summary_confirmed: false, draft_summary: "The checkout timing export sits in a private dashboard.",
        gap_id: metric.id, source_item_ids: ["c5000000-0000-4000-8000-0000000000f2"], unshared_item_ids: [],
      },
    ],
  };
  return db;
}

/** The default company plus a brief whose second goal was rejected since (#260). */
function seedBriefGoalRejectedScenario(): Db {
  const db = seed();
  const approver = db.members.find((m) => m.email === "approver@example.com")!;
  const goal = (key: string) => db.baseline.entities.find((e) => e.type === "goal" && e.key === key)!;
  seedBriefGoalRejected(ensureV2(db), approver.id, [goal("g.activation").id, goal("g.early-churn").id]);
  goal("g.early-churn").status = "rejected";
  return db;
}

/** "questions" plus a private finding (S6): only its author, the signed-in owner, is asked. */
function seedPrivateFinding(): Db {
  const db = seedQuestions();
  const v2 = ensureV2(db);
  const intake = v2.intakes.find((i) => i.title === "Clinic waitlist")!;
  const gap = uuid();
  const at = { created_at: "2026-10-02T09:00:00Z", updated_at: "2026-10-02T09:00:00Z" };
  v2.gaps.push({
    id: gap, intake_id: intake.id, document_id: null, category: "release_rollout", statement: "Is the pilot limited to two clinics?",
    impact: ["risks", "scope"], importance: "high", evidence_ids: [], confidence: null, knowledge_state: "ai_inference",
    status: "asked", owner_id: null, related_modules: ["launch.rollout"], stop_condition: null, entity_ids: [], section_keys: [],
    created_by: null, lock_version: 1, ...at,
  });
  v2.private_gap_ids = [gap];
  v2.questions.push({
    id: uuid(), gap_id: gap, intake_id: intake.id, document_id: null, checkpoint_id: null, item_ref: null, entity_id: null,
    category: "release_rollout", prompt: "Is the pilot limited to two clinics?", rationale: null, priority: 20, batch: 1,
    asked_to: db.user_id, asked_by: db.user_id, module_key: null, section_key: null, status: "asked", ...at,
  });
  return db;
}

/** "questions" in a company of 25 members: zoe.zimmer@example.com sorts last, past the
 * people picker's first page of 20. */
function seedManyPeople(): Db {
  const db = seedQuestions();
  const join = (email: string, i: number) => ({
    email, role: "commenter" as const, engineering_lead: false, created_at: `2026-09-${String(5 + i).padStart(2, "0")}T09:00:00Z`,
    id: uuid(), disabled_at: null, disabled_by: null, status: "active" as const, open_tokens: 0,
  });
  for (let i = 0; i < 20; i++) db.members.push(join(`member.${String(i).padStart(2, "0")}@example.com`, i));
  db.members.push(join("zoe.zimmer@example.com", 20));
  return db;
}

/** The default company with no approved strategy: one open `no_strategy` finding (H4, #244). */
function seedNoStrategyScenario(): Db {
  const db = seed();
  db.strategy = seedNoStrategy(uuid);
  return db;
}

/**
 * The default company plus an approved vision, a product strategy (v1 approved, v2 in
 * review) and open strategy drift findings (H4); "strategy-no-vision" leaves the vision out.
 */
function seedStrategyScenario(vision = true): Db {
  const db = seed();
  for (const d of STRATEGY_DOCUMENTS.filter((x) => vision || x.kind !== "vision")) {
    const doc: DocumentRow = {
      id: uuid(),
      slug: d.slug,
      title: d.title,
      status: d.versions.length > 1 ? "in_review" : "approved",
      kind: d.kind ?? "prd",
      template: d.template ?? null,
      template_version: d.template_version ?? null,
      theme: d.theme ?? null,
      created_at: d.versions[0].created_at,
      updated_at: d.versions.at(-1)!.created_at,
    };
    db.documents.push(doc);
    for (const v of d.versions) {
      const row = buildVersion(doc, v);
      if (v.number === 1) row.approved_at = "2026-10-01T09:00:00Z";
      db.versions.push(row);
    }
  }
  db.strategy = seedStrategy(uuid, db.baseline.entities, { vision });
  return db;
}

/**
 * The default company plus a PRD whose open feedback is three Oracle change requests on
 * feature sections (none on the first section) and one item already addressed: what the
 * Inbox's feedback row leads to.
 */
function seedSuggestions(): Db {
  const db = seed();
  const doc: DocumentRow = {
    id: uuid(),
    slug: FLEET_DOC.slug,
    title: FLEET_DOC.title,
    status: "in_review",
    kind: "prd",
    template: FLEET_DOC.template ?? null,
    template_version: FLEET_DOC.template_version ?? null,
    theme: null,
    created_at: FLEET_DOC.versions[0].created_at,
    updated_at: FLEET_DOC.versions.at(-1)!.created_at,
  };
  db.documents.push(doc);
  for (const v of FLEET_DOC.versions) db.versions.push(buildVersion(doc, v));
  const v1 = findVersion(db, doc, 1)!;
  const v2 = findVersion(db, doc, 2)!;
  addComment(db, v1, {
    section_key: "problem",
    anchor: { exact: "so many are out when the driver comes", prefix: "arrive, ", suffix: "." },
    body: "How many first attempts fail today? Put the number in.",
  }, { created_at: "2026-10-17T11:00:00Z" });
  Object.assign(db.feedback.at(-1)!, {
    status: "addressed",
    addressed_in_version: 2,
    resolution_note: "Added the failed first-attempt rate.",
    updated_at: "2026-10-19T09:00:00Z",
  });
  const llm = (db.llm ??= { jobs: [], suggestions: [], disabled: {} });
  FLEET_SUGGESTIONS.forEach((x, i) => {
    const created_at = `2026-10-19T10:0${i}:00Z`;
    const f: FeedbackRow = {
      id: uuid(),
      document_id: doc.id,
      raised_on_version: 2,
      kind: "general",
      comment_id: null,
      section_review_id: null,
      section_key: x.key,
      summary: x.summary,
      anchor: null,
      verdict: null,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      created_at,
      updated_at: created_at,
    };
    db.feedback.push(f);
    llm.suggestions.push({
      id: uuid(),
      document_id: doc.id,
      feedback_item_id: f.id,
      job_id: null,
      version_number: v2.number,
      classification: "change_request",
      group_key: null,
      duplicate_of: null,
      kind: "section_text",
      section_key: x.key,
      text: x.text,
      edited_text: null,
      rationale: x.rationale,
      pushback: null,
      status: "open",
      override_reason: null,
      decided_by: null,
      decided_at: null,
      applied_in_version: null,
      created_at,
      updated_at: created_at,
    });
  });
  // D14: a question Oracle answered and a remark with nothing to change, on Team workspaces,
  // so the Inbox has a row of every kind to act on (Send answer, Close).
  const w2 = findVersion(db, findDocument(db, "team-workspaces")!, 2)!;
  const replies: [string, Schemas["TextQuoteSelector"], "answer" | "none", string | null, string][] = [
    [
      "Who can see a workspace's billing page?",
      { exact: "One invoice per workspace", prefix: "", suffix: ", with seats" },
      "answer",
      "Workspace owners and billing admins see it; members do not.",
      "The roles section says who manages billing.",
    ],
    [
      "The scope reads well as it is.",
      { exact: "Move existing projects into a workspace", prefix: "", suffix: "." },
      "none",
      null,
      "A remark that approves the section: nothing to change.",
    ],
  ];
  replies.forEach(([body, anchor, kind, text, rationale], i) => {
    const created_at = `2026-10-13T11:1${i}:00Z`;
    addComment(db, w2, { section_key: "scope", anchor, body }, { created_at });
    const f = db.feedback.at(-1)!;
    llm.suggestions.push({
      id: uuid(),
      document_id: f.document_id,
      feedback_item_id: f.id,
      job_id: null,
      version_number: w2.number,
      classification: kind === "answer" ? "question" : "approval",
      group_key: null,
      duplicate_of: null,
      kind,
      section_key: "scope",
      text,
      edited_text: null,
      rationale,
      pushback: null,
      status: "open",
      override_reason: null,
      decided_by: null,
      decided_at: null,
      applied_in_version: null,
      created_at,
      updated_at: created_at,
    });
  });
  return db;
}

/**
 * A3 "eng-review" scenario: the default company with commenter@example.com named engineering
 * lead, and a run waiting at an Engineering review stop (./runs.ts).
 */
function seedEngReview(): Db {
  const db = seed();
  db.members.find((x) => x.email === "commenter@example.com")!.engineering_lead = true;
  seeded("eng-review", () => seedEngReviewRun(db.runs!, runsContext(db)));
  return db;
}

/**
 * F4 "eng-check" scenario: the default company with commenter@example.com named engineering
 * lead, and a Baseline to PRD run waiting at its Engineering check (./runs.ts).
 */
function seedEngCheck(): Db {
  const db = seed();
  db.members.find((x) => x.email === "commenter@example.com")!.engineering_lead = true;
  seeded("eng-check", () => seedEngCheckRun(db.runs!, runsContext(db)));
  return db;
}

/** F4 "eng-check-no-lead" scenario: the "eng-check" run with no engineering lead named (approvers decide). */
function seedEngCheckNoLead(): Db {
  const db = seed();
  seeded("eng-check-no-lead", () => seedEngCheckRun(db.runs!, runsContext(db)));
  return db;
}

/**
 * B2 "baseline-review" scenario: the default seed plus a Build the baseline run waiting at
 * Confirm the baseline with what it wrote to the baseline (./from-run.ts); "baseline-review-
 * console": the same run approved in SwarmCloud's console while its goals are undecided.
 */
function seedBaselineReview(consoleHeld: boolean): Db {
  const db = seed();
  const run = seeded("baseline-review", () => seedBaselineReviewRun(db.runs!, runsContext(db), consoleHeld));
  const lead = db.members.find((m) => m.email === "approver@example.com")!.id;
  seeded("baseline-review-items", () => seedFromRun(db.baseline, run.id, uuid, lead));
  return db;
}

/**
 * D3 "roadmap-items-console-held" scenario: the default company plus the roadmap review run
 * (usage-alerts-roadmap at its Roadmap items checkpoint) approved in SwarmCloud's console
 * while blocking reasons are open, so the approval is held (./runs.ts ROADMAP_REVIEW_HELD_RUN).
 */
function seedRoadmapItemsConsoleHeld(): Db {
  const db = seed();
  const held = structuredClone(ROADMAP_REVIEW_HELD_RUN);
  db.runs!.runs.push(held.run);
  Object.assign(db.runs!.artifacts, held.artifacts);
  return db;
}

/** D10 "run-review" scenario: the default seed plus a run waiting at its PRD review of usage-alerts v2 (./runs.ts). */
function seedRunReview(): Db {
  const db = seed();
  seeded("run-review", () => seedRunReviewRun(db.runs!, runsContext(db)));
  return db;
}

/** D10 "run-review-decider" scenario: "run-review" with usage-alerts' review policy naming approver@example.com its designated decider. */
function seedRunReviewDecider(): Db {
  const db = seedRunReview();
  const doc = db.documents.find((d) => d.slug === "usage-alerts")!;
  const prd = db.documents.find((d) => d.kind === "prd");
  db.review_v2 = seedReviewV2(prd, prd ? docVersions(db, prd).pop() : undefined, db.user_id, hash);
  db.review_v2.policies.push({
    document_id: doc.id, decider_id: db.members.find((m) => m.email === "approver@example.com")!.id, mandatory_reviewer_ids: [],
    required_section_keys: [], section_approval: "required_sections", rereview_on_change: true, source: "document", lock_version: 1,
  });
  return db;
}

/** The default seed plus a run waiting at its feature set with a blocking problem (C6, ./runs.ts). */
function seedFeatureSet(): Db {
  const db = seed();
  seeded("feature-set", () => seedFeatureSetRun(db.runs!, runsContext(db)));
  return db;
}

/** C7 "scope-review": the default seed plus three runs at their feature set (./runs.ts seedScopeReviewRuns). */
function seedScopeReview(): Db {
  const db = seed();
  seeded("scope-review", () => seedScopeReviewRuns(db.runs!, runsContext(db)));
  return db;
}

/**
 * C7 Approve with edits: each requirement a person added becomes a locked, confirmed
 * `requirement` entity of the approver's, part of its feature (the feature's entity, else a
 * proposed one as the agents' proposal would make); an edited one gets the same direct edit.
 */
function scopeToBaseline(db: Db, scope: StoredScope, by: string) {
  const at = new Date().toISOString();
  const s = db.baseline;
  const base = { origin: "user" as const, locked: true, locked_by: by, locked_at: at, confidence: null, run_id: scope.run_id, created_at: at, updated_at: at };
  for (const { feature, requirement, added } of personRequirements(scope)) {
    let f = s.entities.find((e) => e.type === "feature" && (e.id === feature.entity_id || e.key === feature.key || e.key === `f.${feature.key}`));
    if (!f) {
      f = { id: uuid(), type: "feature", key: feature.key, title: feature.title, body: feature.text ?? null, attrs: {}, status: "proposed", origin: "agent", locked: false, locked_by: null, locked_at: null, confidence: feature.confidence ?? null, run_id: scope.run_id, created_at: at, updated_at: at };
      s.entities.push(f);
      // As the API: the agents' open proposal to create it is withdrawn (never listed again).
      const made = (p: (typeof s.proposals)[number]) => {
        const fields = (p.payload.fields ?? {}) as { type?: string; key?: string };
        return p.status === "open" && p.payload.op === "create" && p.payload.kind === "entity" && fields.type === "feature" && fields.key === feature.key;
      };
      s.proposals = s.proposals.filter((p) => !made(p));
    }
    const text = requirement.text ?? requirement.title;
    const attrs = { feature: feature.key, goals: feature.goals.map((g) => g.key), acceptance: requirement.acceptance, from_scope: scope.id };
    const existing = !added && requirement.entity_id ? s.entities.find((e) => e.id === requirement.entity_id) : undefined;
    if (existing) {
      Object.assign(existing, { body: text, attrs: { ...existing.attrs, acceptance: requirement.acceptance }, locked: true, locked_by: by, locked_at: at, updated_at: at });
      continue;
    }
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "requirement";
    let key = `r.${slug}`;
    for (let n = 2; s.entities.some((e) => e.key === key); n++) key = `r.${slug}-${n}`;
    const entity = { ...base, id: uuid(), type: "requirement" as const, key, title: text.slice(0, 80), body: text, attrs, status: "confirmed" as const };
    s.entities.push(entity);
    requirement.entity_id = entity.id;
    s.edges.push({ ...base, id: uuid(), src_id: entity.id, dst_id: f.id, type: "part_of", attrs: {}, status: "confirmed" });
  }
}

/**
 * C8 "priority-order" scenario: two runs waiting at the priority stop (./runs.ts
 * seedPriorityRuns), one for the Saved addresses PRD, and a run order saved for the
 * Checkout redesign PRD.
 */
function seedPriorityOrder(): Db {
  const db = seed();
  const at = "2026-10-18T09:00:00Z";
  db.documents.push({
    id: uuid(), slug: "saved-addresses", title: "Saved addresses PRD", status: "draft", kind: "prd",
    template: null, template_version: null, theme: null, created_at: at, updated_at: at,
  });
  seeded("priority-order", () => seedPriorityRuns(db.runs!, runsContext(db)));
  return db;
}

/**
 * D12 "next-draft" scenario: the fleet PRD on draft 2 with two accepted section-text
 * changes (F-33, F-34), a whole-draft remark staged for the agents and one nobody staged
 * yet. "next-draft-costly": the same, with the agents' run estimated over the owner-approval
 * threshold.
 */
function seedNextDraft(costly: boolean): Db {
  const db = seed();
  const doc: DocumentRow = {
    id: uuid(),
    slug: FLEET_DOC.slug,
    title: FLEET_DOC.title,
    status: "in_review",
    kind: "prd",
    template: FLEET_DOC.template ?? null,
    template_version: FLEET_DOC.template_version ?? null,
    theme: null,
    created_at: FLEET_DOC.versions[0].created_at,
    updated_at: FLEET_DOC.versions.at(-1)!.created_at,
  };
  db.documents.push(doc);
  for (const v of FLEET_DOC.versions) db.versions.push(buildVersion(doc, v));
  const v2 = findVersion(db, doc, 2)!;
  const llm = (db.llm ??= { jobs: [], suggestions: [], disabled: {} });
  const item = (key: string | null, summary: string, created_at: string, staged = false): FeedbackRow => {
    const f: FeedbackRow = {
      id: uuid(),
      document_id: doc.id,
      raised_on_version: 2,
      kind: "general",
      comment_id: null,
      section_review_id: null,
      section_key: key,
      summary,
      anchor: null,
      verdict: null,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      created_at,
      updated_at: created_at,
      staged_for_agents_at: staged ? "2026-10-19T12:00:00Z" : null,
      staged_for_agents_by: staged ? db.user_id : null,
    };
    db.feedback.push(f);
    return f;
  };
  FLEET_SUGGESTIONS.filter((x) => x.key !== "f-36").forEach((x, i) => {
    const created_at = `2026-10-19T10:0${i}:00Z`;
    const f = item(x.key, x.summary, created_at);
    llm.suggestions.push({
      id: uuid(),
      document_id: doc.id,
      feedback_item_id: f.id,
      job_id: null,
      version_number: v2.number,
      classification: "change_request",
      group_key: null,
      duplicate_of: null,
      kind: "section_text",
      section_key: x.key,
      text: x.text,
      edited_text: null,
      rationale: x.rationale,
      pushback: null,
      status: "accepted",
      override_reason: null,
      decided_by: db.user_id,
      decided_at: "2026-10-19T11:00:00Z",
      applied_in_version: null,
      created_at,
      updated_at: created_at,
    });
  });
  item(null, "The draft never says how drivers learn the new app.", "2026-10-19T10:05:00Z", true);
  item(null, "Say which fleets join the pilot first.", "2026-10-19T10:06:00Z");
  if (costly) db.next_draft_run_usd = 64;
  return db;
}

/** The "named-codes" scenario's PRD (#305): agent-written text with bare codes (./named-codes.ts). */
function addCodedPrd(db: Db) {
  const at = CODED_PRD.versions[0].created_at;
  const row: DocumentRow = {
    id: uuid(),
    slug: CODED_PRD.slug,
    title: CODED_PRD.title,
    status: "in_review",
    kind: "prd",
    template: CODED_PRD.template ?? null,
    template_version: CODED_PRD.template_version ?? null,
    theme: null,
    created_at: at,
    updated_at: at,
  };
  db.documents.push(row);
  db.versions.push(buildVersion(row, CODED_PRD.versions[0]));
}

/** The default seed plus one PRD of 100+ sections in nested chapters (./big-prd.ts). */
function seedBigPrd(): Db {
  const db = seed();
  const row: DocumentRow = {
    id: uuid(),
    slug: BIG_PRD.slug,
    title: BIG_PRD.title,
    status: "in_review",
    kind: "prd",
    template: BIG_PRD.template ?? null,
    template_version: BIG_PRD.template_version ?? null,
    theme: null,
    created_at: BIG_PRD.versions[0].created_at,
    updated_at: BIG_PRD.versions[0].created_at,
  };
  db.documents.push(row);
  const v = buildVersion(row, BIG_PRD.versions[0]);
  db.versions.push(v);
  const at = "2026-10-19T10:00:00Z";
  for (const [key, r] of Object.entries(BIG_PRD_REVIEWS)) addReview(db, v, key, r, { created_at: at });
  const comments = BIG_PRD_COMMENTS.map(([key, exact, text], i) => {
    const plain = v.sections.find((s) => s.section_key === key)!.body_text;
    const start = plain.indexOf(exact);
    const anchor = { exact, prefix: plain.slice(Math.max(0, start - 32), start), suffix: plain.slice(start + exact.length, start + exact.length + 32) };
    return addComment(db, v, { section_key: key, anchor, body: text }, { created_at: `2026-10-19T11:${String(10 + i).padStart(2, "0")}:00Z` });
  });
  const llm = (db.llm ??= { jobs: [], suggestions: [], disabled: {} });
  for (const s of BIG_PRD_SUGGESTIONS) {
    const c = comments.find((x) => x.body === s.comment)!;
    llm.suggestions.push({
      id: uuid(),
      document_id: row.id,
      feedback_item_id: c.feedback_item_id!,
      job_id: null,
      version_number: 1,
      classification: "change_request",
      group_key: null,
      duplicate_of: null,
      kind: "section_text",
      section_key: c.section_key,
      text: s.text,
      edited_text: null,
      rationale: s.rationale,
      pushback: null,
      status: s.status,
      override_reason: null,
      decided_by: s.status === "open" ? null : db.user_id,
      decided_at: s.status === "open" ? null : at,
      applied_in_version: null,
      created_at: at,
      updated_at: at,
    });
    // Dismissed with "decline the feedback".
    if (s.status === "dismissed") Object.assign(db.feedback.find((f) => f.id === c.feedback_item_id)!, { status: "declined", resolution_note: "Kept as written." });
  }
  // One resolved thread: Done.
  comments.find((c) => c.body.startsWith("List the shortcuts"))!.resolved_at = at;
  return db;
}

function seed(): Db {
  const db: Db = {
    session: null,
    tenant_id: uuid(),
    user_id: uuid(),
    members: [],
    invites: [],
    documents: [],
    versions: [],
    comments: [],
    reviews: [],
    feedback: [],
    baseline: seedBaseline(uuid),
  };
  db.members = MOCK_MEMBERS.map((m) => ({
    ...m,
    id: m.email === MOCK_LOGIN.email ? db.user_id : uuid(),
    disabled_at: null,
    disabled_by: null,
    status: "active" as const,
    last_sign_in_at: m.last_sign_in_at,
    open_tokens: 0,
  }));
  // The seeded commenter proposal is the commenter's (B4 names who made it).
  attributeCommenterProposal(db.baseline, db.members.find((m) => m.email === "commenter@example.com")!.id);
  // B5: activation's owner is the approver.
  attributeGoalOwner(db.baseline, db.members.find((m) => m.email === "approver@example.com")!.id);
  // The colleague who locked the seeded items is the approver (#505: the lock names a person).
  attributeLocks(db.baseline, db.members.find((m) => m.email === "approver@example.com")!.id);
  // A member removed two days ago (C2): kept, so history keeps the name; an owner can restore.
  db.members.push({
    ...REMOVED_MEMBER,
    id: uuid(),
    disabled_by: db.user_id,
    status: "disabled",
    open_tokens: 0,
  });
  db.invites = MOCK_INVITES.map((i) => ({
    ...i,
    id: uuid(),
    status: "open",
    invited_by: db.user_id,
    accepted_at: null,
    revoked_at: null,
    access: "granted",
    access_at: i.created_at,
    email_status: "sent",
    email_at: i.created_at,
    sign_in_url: signInUrl(),
    // A5: 14 days from creation.
    expires_at: new Date(Date.parse(i.created_at) + 14 * 86_400_000).toISOString(),
    resend_count: 0,
  }));
  const docs = new Map<string, DocumentRow>();
  for (const d of DOCUMENTS as DocumentSeed[]) {
    const last = d.versions[d.versions.length - 1];
    const row: DocumentRow = {
      id: uuid(),
      slug: d.slug,
      title: d.title,
      status: "draft",
      kind: d.kind ?? "prd",
      template: d.template ?? null,
      template_version: d.template_version ?? null,
      theme: d.theme ?? null,
      created_at: d.versions[0].created_at,
      updated_at: last.created_at,
    };
    db.documents.push(row);
    docs.set(d.slug, row);
    for (const v of d.versions) db.versions.push(buildVersion(row, v));
  }

  const ver = (slug: string, n: number) => findVersion(db, docs.get(slug)!, n)!;
  const at = (iso: string) => ({ created_at: iso });

  // Checkout redesign: v1 was reviewed, v2 answered that feedback.
  const c1 = ver("checkout-redesign", 1);
  addComment(db, c1, {
    section_key: "problem",
    anchor: {
      exact: "Most abandonment happens at the shipping step",
      prefix: "Buyers leave checkout when the total changes late in the flow. ",
      suffix: ", right after shipping cost appears",
    },
    body: "Can we put a number on this? A funnel figure would make the case much stronger.",
  }, at("2026-10-16T15:02:00Z"));
  addComment(db, c1, {
    section_key: "s-5-2",
    anchor: {
      exact: "Each option shows its price and delivery window",
      prefix: "Replace the free-text shipping options with three clear choices: standard, express and pickup. ",
      suffix: " before it is selected.",
    },
    body: "Which option is preselected? Defaulting to the cheapest one would match the cart estimate.",
  }, at("2026-10-16T15:10:00Z"));
  addReview(db, c1, "goal-trace", { verdict: "approved", note: "Clear link to G1." }, at("2026-10-16T15:20:00Z"));
  addReview(db, c1, "metrics", {
    verdict: "changes_requested",
    note: "Add a guardrail metric so we notice if a faster checkout increases refunds.",
  }, at("2026-10-16T15:24:00Z"));
  addReview(db, c1, "rollout", {
    verdict: "rejected",
    note: "Rollout belongs in the launch plan, not in this PRD.",
  }, at("2026-10-16T15:26:00Z"));
  const notes: Record<string, string> = {
    problem: "Added the September funnel numbers to §2.",
    "s-5-2": "The cheapest option is now preselected, see §5.2.",
    metrics: "Added a refund-rate guardrail and a stop rule.",
    rollout: "Removed; the rollout now lives in the launch plan.",
  };
  for (const f of db.feedback) {
    if (f.raised_on_version === 1 && f.document_id === c1.document_id && f.section_key && notes[f.section_key]) {
      Object.assign(f, {
        status: "addressed",
        addressed_in_version: 2,
        resolution_note: notes[f.section_key],
        updated_at: "2026-10-17T09:20:00Z",
      });
    }
  }
  addComment(db, ver("checkout-redesign", 2), {
    section_key: "s-5-3",
    anchor: {
      exact: "Choosing a card fills the form",
      prefix: "eir saved addresses as cards on the shipping step. ",
      suffix: " and recalculates the shipping options in place.",
    },
    body: "Should the most recently used address be selected by default?",
  }, at("2026-10-17T09:40:00Z"));
  docs.get("checkout-redesign")!.status = "in_review";

  // Team workspaces: an approved section changed in v2.
  const w1 = ver("team-workspaces", 1);
  addReview(db, w1, "roles", { verdict: "approved", note: null }, at("2026-10-12T16:00:00Z"));
  addReview(db, w1, "scope", { verdict: "approved", note: null }, at("2026-10-12T16:02:00Z"));
  ver("team-workspaces", 2).warnings = [
    {
      code: "locked_section_changed",
      message: "Sections approved in v1 changed in this version: scope",
      section_keys: ["scope"],
      refs: {},
    },
  ];
  // Review comments on v2, which Oracle's review job has already handled (./llm-jobs.ts).
  const w2 = ver("team-workspaces", 2);
  addComment(db, w2, {
    section_key: "problem",
    anchor: { exact: "Requests for shared editing come up in most sales conversations", prefix: "around. ", suffix: " with teams" },
    body: "Say how many teams asked for this; a number would make the case.",
  }, at("2026-10-13T10:50:00Z"));
  addComment(db, w2, {
    section_key: "problem",
    anchor: { exact: "People share work by exporting files", prefix: "", suffix: " and sending" },
    body: "Can we quantify the demand from the sales calls?",
  }, at("2026-10-13T10:55:00Z"));
  addComment(db, w2, {
    section_key: "roles",
    anchor: { exact: "Three fixed roles", prefix: "", suffix: ": owner" },
    body: "Add custom roles to the first release; big teams will ask for them.",
  }, at("2026-10-13T11:00:00Z"));
  docs.get("team-workspaces")!.status = "in_review";

  // Clinic outreach (C1e): feedback in every state; the suggestions are in ./llm-jobs.ts.
  addComment(db, ver("clinic-outreach", 3), {
    section_key: "problem",
    anchor: { exact: "in every pilot clinic", prefix: "from paper lists, ", suffix: "." },
    body: "Name the clinics in the pilot.",
  }, at("2026-10-08T12:00:00Z"));
  for (const f of db.feedback) {
    if (f.summary === "Name the clinics in the pilot.") {
      Object.assign(f, { status: "addressed", addressed_in_version: 4, resolution_note: "The three pilot clinics are named in the problem.", updated_at: "2026-10-09T10:00:00Z" });
    }
  }
  addComment(db, ver("clinic-outreach", 4), {
    section_key: "goal-trace",
    anchor: { exact: "Serves G1 activation", prefix: "", suffix: ": more new patients" },
    body: "Trace this to G2 retention, not activation: these are returning patients.",
  }, at("2026-10-09T15:00:00Z"));
  const o5 = ver("clinic-outreach", 5);
  addComment(db, o5, {
    section_key: "f-38",
    anchor: { exact: "After each outbound call", prefix: "", suffix: ", the agent checks" },
    body: "Run the outbound check before the call is placed, not after.",
  }, at("2026-10-18T14:00:00Z"));
  addComment(db, o5, {
    section_key: "problem",
    anchor: { exact: "40% of missed visits", prefix: "", suffix: " are never rebooked" },
    body: "Drop the 40% figure; it is from 2024.",
  }, at("2026-10-18T14:20:00Z"));
  addComment(db, o5, {
    section_key: "metrics",
    anchor: { exact: "Calls per rebooking", prefix: "- ", suffix: ": 3.1 today" },
    body: "Add a metric that shows the outbound check works.",
  }, at("2026-10-19T09:30:00Z"));
  docs.get("clinic-outreach")!.status = "in_review";

  // Usage alerts: fully approved.
  const a1 = ver("usage-alerts", 1);
  for (const s of a1.sections) addReview(db, a1, s.section_key, { verdict: "approved", note: null }, at("2026-10-03T10:00:00Z"));
  a1.approved_at = "2026-10-03T10:05:00Z";
  docs.get("usage-alerts")!.status = "approved";

  // Provenance (O4b): roadmap versions record the approved PRD version they came from.
  for (const d of DOCUMENTS as DocumentSeed[]) {
    for (const v of d.versions) {
      if (v.source) ver(d.slug, v.number).source = versionSource(docs.get(v.source.slug)!, ver(v.source.slug, v.source.version));
    }
  }
  // #482 "trash-family": the early shipping cost brief is usage-alerts' tech brief too, so
  // that PRD has a derived roadmap and a spec (deleting it takes both to Trash). As the spec
  // import makes it: through its spec request, with no source on the brief's versions.
  if (localStorage.getItem(MOCK_SCENARIO_KEY) === "trash-family") {
    const brief = docs.get("checkout-redesign-early-shipping-cost-spec")!;
    for (const v of db.versions) if (v.document_id === brief.id) v.source = null;
    db.specs ??= seedSpecs();
    for (const s of db.specs.specs) if (s.document_slug === brief.slug) s.request.source_document_id = docs.get("usage-alerts")!.id;
  }
  docs.get("usage-alerts-roadmap")!.status = "in_review";
  db.runs = seeded("runs", () => seedRuns(runsContext(db)));
  db.llm = seeded("llm", () => seedLlm(llmContext(db, db.user_id, "owner")));
  seeded("updates", () => seedUpdates(db));
  return db;
}

/**
 * H8: the synthetic investor and board updates (./fixtures.ts), seen by owners and approvers
 * only. Seeded last, under their own ids, so every other seeded id stays as it was.
 */
function seedUpdates(db: Db) {
  for (const d of UPDATE_DOCUMENTS) {
    const doc: DocumentRow = {
      id: uuid(),
      slug: d.slug,
      title: d.title,
      status: d.status,
      kind: "update",
      template: d.template,
      template_version: d.template_version ?? "1",
      theme: d.theme ?? null,
      visibility: "approvers",
      created_at: d.versions[0].created_at,
      updated_at: d.approved_at ?? d.versions.at(-1)!.created_at,
    };
    db.documents.push(doc);
    for (const seedV of d.versions) {
      const v = buildVersion(doc, seedV);
      v.front_matter = updateFrontMatter(d.template, doc.slug, doc.title, d.period);
      if (d.approved_at && seedV.number === d.versions.at(-1)!.number) v.approved_at = d.approved_at;
      db.versions.push(v);
    }
  }
}

function llmContext(db: Db, userId: string, role: Role): LlmContext {
  return {
    db: db.llm ?? { jobs: [], suggestions: [], disabled: {} },
    userId,
    role,
    documents: db.documents,
    versions: db.versions,
    feedback: db.feedback,
    uuid,
    now,
    lockedKeys: (v) => lockedKeys(db, v as VersionRow),
    sentToAgents: (sid) =>
      (db.runs?.runs ?? []).some((r) => !["succeeded", "failed", "cancelled"].includes(r.status) && !!(r as SentRun).sent?.suggestion_ids.includes(sid)),
    reply: (feedbackId, body) => {
      const parent = db.comments.find((c) => c.id === db.feedback.find((f) => f.id === feedbackId)?.comment_id);
      if (!parent) return;
      db.comments.push({ ...parent, id: uuid(), anchor: null, body, author_id: userId, parent_id: parent.id, created_at: now(), feedback_item_id: null });
    },
    importRevision: (doc, base, key, heading, body, resolutions) =>
      importSections(db, doc, base as VersionRow, { [key]: { heading, body } }, resolutions),
    importSections: (doc, base, replace, resolutions) => importSections(db, doc, base as VersionRow, replace, resolutions),
    memberName: (id) => db.members.find((m) => m.id === id)?.email ?? null,
    discussion: (id) => {
      const d = db.discussions?.discussions.find((x) => x.id === id);
      if (!d) return null;
      const inIt = db.discussions!.participants.some((x) => x.discussion_id === id && x.user_id === userId && !x.left_at);
      const priv = d.visibility === "private";
      return priv && !inIt ? { id: null, title: null, private: true } : { id: d.id, title: d.title, private: priv };
    },
    runEstimateUsd: () => db.next_draft_run_usd ?? null,
    // D12: Build next draft with the agents: a feedback-loop run, estimated and started.
    startRun: async (doc, input) => {
      db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
      const rc = { ...runsContext(db), db: db.runs };
      const call = (path: string, payload?: unknown) =>
        routeRuns(
          rc,
          new Request(new URL(path, "http://localhost"), {
            method: "POST",
            body: payload ? JSON.stringify(payload) : undefined,
            headers: { "Content-Type": "application/json" },
          }),
          path.split("/").filter(Boolean),
        );
      const created = await call("/v1/runs", { flow: "feedback_loop", document: doc.slug, knobs: { depth: input.depth } });
      if (!created || !created.ok) return created ?? notFound("Route");
      const { id } = (await created.json()) as Schemas["RunOut"];
      await call(`/v1/runs/${id}/estimate`);
      const run = db.runs.runs.find((r) => r.id === id)! as SentRun;
      run.estimate_usd = input.estimate_usd;
      run.segments[0].estimate_usd = input.estimate_usd;
      run.sent = { feedback_ids: input.feedback_ids, suggestion_ids: input.suggestion_ids };
      const started = (await call(`/v1/runs/${id}/start`))!;
      return new Response(started.body, { status: started.ok ? 201 : started.status, headers: started.headers });
    },
  };
}

/** D12: a feedback-loop run started from Build next draft, with the items it was sent. */
type SentRun = Schemas["RunOut"] & { sent?: { feedback_ids: string[]; suggestion_ids: string[] } };

/**
 * C1e: the Inbox's feedback by state for approvers (new since my last visit, open, staged,
 * declined, done), the staged rows, and open feedback that leaves staged and settled items out.
 */
function withInboxStates(
  db: Db,
  llm: LlmContext,
  me: { id: string; role: Role },
  base: Schemas["InboxOut"],
  markSeen: boolean,
): Schemas["InboxOut"] {
  db.inbox_seen ??= {};
  const seen = db.inbox_seen[me.id] ?? null;
  if (markSeen) db.inbox_seen[me.id] = now();
  // Decisions not delivered yet show to the review's approver role and above, as the API.
  if (!atLeast(me.role, "approver")) return { ...base, deliveries: [], last_seen_at: seen };
  const states = inboxStates(llm, seen);
  // Open feedback per document comes from ./runs.ts (staged items left out there); its
  // items carry their state here.
  const byId = new Map(states.items.map((i) => [i.id, i]));
  const feedback = base.feedback.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, ...byId.get(i.id), kind: i.kind })) }));
  return {
    ...base,
    feedback,
    // Every new or open item, as the API: = the Inbox's New + Open tabs (owner, 2026-10-20).
    total: base.total + states.needs_me,
    ...states,
    last_seen_at: seen,
  };
}

/** What the decision log mock reads: the signed-in member, the members, the runs' stops. */
function decisionsContext(db: Db, me: MemberRow): DecisionsContext {
  return {
    me: { id: me.id, email: me.email, role: me.role, status: me.status },
    members: db.members.map((m) => ({ id: m.id, email: m.email, role: m.role, status: m.status })),
    runs: (db.runs?.runs ?? []) as unknown as DecisionsContext["runs"],
    documentTitle: (slug) => db.documents.find((d) => d.slug === slug)?.title ?? null,
    hiddenDocument: (key) => {
      const versionOf = db.versions.find((v) => v.id === key)?.document_id;
      const doc = db.documents.find((d) => d.id === key || d.slug === key || d.id === versionOf);
      return !!doc && !canSee(me.role, doc.visibility);
    },
    // H9 (docs/visibility._decision_visible): a pricing decision, and the record of a stop of
    // a run on an owners-and-approvers document, are absent for commenters and viewers.
    visible: (d) => {
      if (atLeast(me.role, "approver")) return true;
      if (d.origin === "pricing") return false;
      const run = d.run_id ? db.runs?.runs.find((r) => r.id === d.run_id) : undefined;
      const doc = run?.document_slug ? findDocument(db, run.document_slug) : undefined;
      return !doc || canSee(me.role, doc.visibility);
    },
    uuid,
    now,
  };
}

/** What the pricing mock reads: the signed-in member, today in the Company time zone. */
function pricingContext(me: MemberRow): PricingContext {
  return {
    me: { id: me.id, role: me.role },
    uuid,
    now,
    today: () => todayIn(String(mockSettingValue("company_timezone") ?? "America/Los_Angeles")),
  };
}

/** The pricing owner (oracle.pricing.decide.pricing_owner): the setting's active owner, else the earliest active owner. */
function pricingOwner(db: Db): MemberRow | undefined {
  const owners = db.members.filter((m) => m.role === "owner" && m.status === "active").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const chosen = mockSettingValue("pricing_owner");
  return owners.find((m) => m.id === chosen) ?? owners[0];
}

/** A member's name as the API shows it (oracle.members.names.display_name). */
function memberName(m: MemberRow | undefined): string {
  return m ? displayName(m.email, m.name) : "the pricing owner";
}

/** A memo version's sections as Decide and the list read them. */
function memoOf(db: Db, doc: DocumentRow) {
  const latest = docVersions(db, doc).pop();
  const fm = (latest?.front_matter ?? {}) as Record<string, unknown>;
  return { latest, question: typeof fm.question === "string" ? fm.question : null, fm };
}

/** GET /v1/pricing-memos: the pricing documents with their decision and who decides. */
function pricingMemos(db: Db): Schemas["PricingMemoSummary"][] {
  const owner = pricingOwner(db);
  const decisions = db.decisions?.decisions ?? [];
  return db.documents
    .filter((d) => d.kind === "pricing")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((doc) => {
      const { latest, question } = memoOf(db, doc);
      const ids = new Set(docVersions(db, doc).map((v) => v.id));
      const d = decisions.filter((x) => x.origin === "pricing" && x.source && ids.has(x.source.id)).pop();
      const state = d?.status === "decided" ? "decided" : latest?.approved_at ? "approved" : doc.status === "in_review" ? "in_review" : "draft";
      return {
        document_id: doc.id,
        slug: doc.slug,
        title: doc.title,
        question,
        state,
        decision: d ? { number: d.number, title: d.title, status: d.status, chosen_label: d.options.find((o) => o.key === d.chosen_option)?.label ?? null } : null,
        updated_at: doc.updated_at,
        pricing_owner: owner ? { id: owner.id, name: memberName(owner) } : null,
      };
    });
}

/** POST /v1/pricing-memos/{doc}/decide: the pricing owner opens the approved memo's proposed decision. */
function decideMemo(db: Db, me: MemberRow, slug: string): Response {
  const doc = findDocument(db, slug);
  if (!doc || doc.kind !== "pricing") return json(404, { detail: `pricing memo '${slug}' not found` });
  const owner = pricingOwner(db);
  if (!owner || owner.id !== me.id) return json(403, { detail: `Only ${memberName(owner)} decides prices` });
  const { latest, question, fm } = memoOf(db, doc);
  if (!latest?.approved_at) return json(409, { detail: "Approve the memo's latest version before deciding" });
  db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
  const ctx = decisionsContext(db, me);
  db.decisions ??= seeded("decisions", () => seedDecisions(ctx));
  const recommendation = latest.sections.find((s) => s.section_key === "recommendation")?.body_md ?? "";
  const { row, created } = proposePricing(
    ctx,
    db.decisions,
    {
      versionId: latest.id,
      documentId: doc.id,
      version: latest.number,
      slug: doc.slug,
      question: question ?? doc.title,
      context: recommendation,
      options: memoOptions(fm, latest.sections),
    },
    owner.id,
  );
  return json(created ? 201 : 200, row);
}

/** /v1/pricing-memos…, /v1/deal-outcomes… and the pricing_owner setting (H9); null for other routes. */
async function routePricing(db: Db, me: MemberRow, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] === "pricing-memos") {
    // H8's rule: below approver, there is no such memo.
    if (!atLeast(me.role, "approver")) return notFound("Pricing memo");
    if (p.length === 2 && req.method === "GET") return json(200, pricingMemos(db));
    if (p.length === 4 && p[3] === "decide" && req.method === "POST") return decideMemo(db, me, p[2]);
    return null;
  }
  if (p[1] === "deal-outcomes") return routeDeals(pricingContext(me), (db.pricing ??= { deals: [] }), req, p, q);
  if (p[1] === "settings" && p[2] === "pricing_owner" && req.method === "PUT" && me.role === "owner") {
    const { value } = (JSON.parse((await req.clone().text()) || "{}") ?? {}) as { value?: unknown };
    if (value != null && !db.members.some((m) => m.id === value && m.role === "owner" && m.status === "active")) {
      return json(422, { detail: "The pricing owner must be an active owner" });
    }
  }
  return null;
}

/** H9 "pricing" scenario: Riley Park, a second owner; Team plan pricing approved, Starter plan price decided; made-up deals. */
function seedPricingScenario(db: Db) {
  const second: MemberRow = {
    ...db.members.find((m) => m.id === db.user_id)!,
    id: uuid(),
    email: "riley@example.com",
    name: "Riley Park",
    role: "owner",
    created_at: "2026-09-05T09:00:00Z",
    last_sign_in_at: "2026-10-20T08:00:00Z",
  };
  db.members.push(second);
  db.pricing = { deals: seedDeals(pricingContext(db.members.find((m) => m.id === db.user_id)!), db.user_id) };
  const window: EvidenceWindow = { from: "2026-04-24", to: "2026-10-23" };
  const memo = (slug: string, title: string, question: string, approvedAt: string) => {
    const doc: DocumentRow = {
      id: uuid(), slug, title, status: "approved", kind: "pricing", template: PRICING_TEMPLATE, template_version: "1",
      theme: "one-page-brief", visibility: "approvers", created_at: "2026-10-12T16:00:00Z", updated_at: approvedAt,
    };
    db.documents.push(doc);
    const v1 = buildVersion(doc, { number: 1, created_at: doc.created_at, sections: pricingTemplateSections(title), citations: [], brief: ["question", "recommendation", "options"] });
    v1.front_matter = pricingFrontMatter(slug, title, question, window);
    v1.imported_by = "draft-picker";
    const v2 = buildVersion(doc, { number: 2, created_at: "2026-10-13T16:00:00Z", sections: pricingDraftSections(title, question, window), citations: [], brief: ["question", "recommendation", "options"] });
    v2.front_matter = pricingFrontMatter(slug, title, question, window, DRAFT_OPTIONS);
    v2.imported_by = "agent-track";
    v2.approved_at = approvedAt;
    db.versions.push(v1, v2);
  };
  memo("team-plan-pricing", "Team plan pricing", "Should the team plan move from per-seat to a flat price per team?", "2026-10-15T17:00:00Z");
  memo("starter-plan-price", "Starter plan price", "Should the Starter plan cost less for teams under 5 seats?", "2026-10-08T17:00:00Z");
}

/** The pricing scenario's earlier memo, decided by the pricing owner (a pricing decision in the log). */
function seedPricingDecisions(db: Db, ctx: DecisionsContext, log: DecisionsDb) {
  const doc = findDocument(db, "starter-plan-price");
  const owner = pricingOwner(db);
  if (!doc || !owner) return;
  const { latest, question, fm } = memoOf(db, doc);
  if (!latest) return;
  const { row } = proposePricing(
    { ...ctx, me: { id: owner.id, email: owner.email, role: owner.role } },
    log,
    { versionId: latest.id, documentId: doc.id, version: latest.number, slug: doc.slug, question: question ?? doc.title, context: "", options: memoOptions(fm, latest.sections) },
    owner.id,
  );
  decidePricing(ctx, log, row.number, "keep", "Small teams churn on budget, not on price.", "Starter churn stays under 3% a month.", "2026-10-09T17:00:00Z");
}

/** What the rituals mock reads: the signed-in member and the members. */
function ritualsContext(db: Db, me: MemberRow): RitualsContext {
  return {
    me: { id: me.id, email: me.email, role: me.role, status: me.status },
    members: db.members.map((m) => ({ id: m.id, email: m.email, role: m.role, status: m.status })),
    uuid,
    companyTimezone: () => String(mockSettingValue("company_timezone") ?? "America/Los_Angeles"),
    decisions: () => db.decisions?.decisions ?? [],
    openVariances: (id) => openVariances(ensureMetrics(db, me), id),
    marketWrites: () => levelFor((db.autonomy ??= emptyAutonomy()), "market") !== "observe",
  };
}

/** What the metrics mock reads: the signed-in member, the members and the goals. */
function metricsContext(db: Db, me: MemberRow): MetricsContext {
  return {
    me: { id: me.id, email: me.email, name: me.name, role: me.role, status: me.status },
    members: db.members.map((m) => ({ id: m.id, email: m.email, name: m.name, role: m.role, status: m.status })),
    uuid,
    companyTimezone: () => String(mockSettingValue("company_timezone") ?? "America/Los_Angeles"),
    goals: () =>
      db.baseline.entities
        .filter((e) => e.type === "goal")
        .map((e) => ({ id: e.id, title: e.title, unit: typeof e.attrs.unit === "string" ? e.attrs.unit : null, confirmed: e.status === "confirmed" })),
  };
}

/** H5: the metrics; the "metrics" scenario seeds them, every other company has none. */
function ensureMetrics(db: Db, me: MemberRow): MetricsDb {
  db.metrics ??= localStorage.getItem(MOCK_SCENARIO_KEY) === "metrics" ? seedMetrics(metricsContext(db, me)) : emptyMetrics();
  return db.metrics;
}

/** The rituals; the "metrics" scenario adds the Weekly metrics review that replaced the goals check-in. */
function ensureRituals(db: Db, me: MemberRow): RitualsDb {
  if (db.rituals) return db.rituals;
  const ctx = ritualsContext(db, me);
  const scenario = localStorage.getItem(MOCK_SCENARIO_KEY);
  db.rituals = seedRituals(ctx, scenario === "rituals");
  if (scenario === "metrics") {
    const metrics = ensureMetrics(db, me);
    addMetricsReview(ctx, db.rituals, (id, asOf) => reviewBlocks(metricsContext(db, me), metrics, id, asOf));
  }
  if (scenario === "market") {
    const market = ensureMarket(db);
    addDigest(ctx, db.rituals, MARKET_DIGEST_ID, (asOf) => digestBlocks(market, ctx.companyTimezone(), asOf));
  }
  return db.rituals;
}

/** The "market" scenario's digest ritual, which the seeded change log and findings link to. */
const MARKET_DIGEST_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/** H7: the market's alternatives, change log and positioning; seeded in the "market" scenario only. */
function ensureMarket(db: Db): MarketDb {
  return (db.market ??= localStorage.getItem(MOCK_SCENARIO_KEY) === "market" ? seedMarket(MARKET_DIGEST_ID) : emptyMarket());
}

/** The next version: the base with some sections replaced, and the resolutions recorded. */
function importSections(
  db: Db,
  doc: { id: string },
  from: VersionRow,
  replace: Record<string, { heading: string; body: string }>,
  resolutions: { feedback_id: string; status: "addressed" | "declined"; note: string | null }[],
): VersionRow {
  const row = findDocument(db, doc.id)!;
  const v = buildVersion(row, {
    number: from.number + 1,
    created_at: now(),
    snapshot: from.snapshot ?? undefined,
    sections: from.sections.map((x) => ({
      key: x.section_key,
      level: x.level,
      heading: replace[x.section_key]?.heading ?? x.heading,
      body: replace[x.section_key]?.body ?? x.body_md,
    })),
    citations: from.citations.map((c) => ({
      id: c.cite_key,
      source: c.source,
      ref: c.ref,
      title: c.title ?? "",
      excerpt: c.excerpt ?? "",
      retrieved_at: c.retrieved_at ?? "",
      added: c.added,
      state_label: c.state_label ?? undefined,
      item: c.item_id ?? undefined,
      confidence: c.confidence,
      confidence_note: c.confidence_note ?? undefined,
      low_confidence: c.low_confidence,
    })),
  });
  db.versions.push(v);
  queueDraft(db, doc.id, v);
  for (const r of resolutions) {
    const f = db.feedback.find((x) => x.id === r.feedback_id);
    if (f && f.status === "open") Object.assign(f, { status: r.status, resolution_note: r.note, addressed_in_version: v.number, updated_at: now() });
  }
  // Duplicates of what was resolved go with it.
  for (const s of db.llm?.suggestions ?? []) {
    const f = db.feedback.find((x) => x.id === s.feedback_item_id);
    if (s.kind === "duplicate" && f?.status === "open" && resolutions.some((r) => r.feedback_id === s.duplicate_of)) {
      Object.assign(f, { status: "addressed", resolution_note: "Addressed with the item it duplicates", addressed_in_version: v.number, updated_at: now() });
    }
  }
  touch(db, doc.id);
  return v;
}

function runsContext(db: Db): Omit<RunsContext, "db"> & { db?: RunsDb } {
  const session = sessionOf(db);
  const member = db.members.find((m) => m.email === session) ?? db.members.find((m) => m.id === db.user_id);
  return {
    db: db.runs,
    userId: db.user_id,
    userName: session ?? db.members.find((m) => m.id === db.user_id)?.email ?? null,
    userRole: member ? withMockRole(member).role : null,
    // A3, as oracle.members.leads.may_decide: an engineering stop outside prd_to_spec goes to
    // the engineering leads and owners once one is named, else to its role and above.
    mayDecide: (c, flow) => {
      if (!member || !ENGINEERING_KINDS.includes(c.kind)) return true;
      const role = withMockRole(member).role;
      const leads = engineeringLeads(db);
      if (flow !== "prd_to_spec" && leads.length) return role === "owner" || (leads.includes(member.id) && atLeast(role, "commenter"));
      return atLeast(role, c.approver_role);
    },
    leadStop: (c, flow) => ENGINEERING_KINDS.includes(c.kind) && flow !== "prd_to_spec" && engineeringLeads(db).length > 0,
    setEffort: (key, size, runId) => setEntityEffort(db.baseline, key, size, member?.id ?? db.user_id, runId),
    member: member ? { id: member.id, email: member.email, role: withMockRole(member).role } : null,
    reviewDecider: (c) => runReviewDecider(db, c),
    members: db.members.map((x) => ({ id: x.id, email: x.email, role: x.role })),
    scopeApproved: (scope, by) => scopeToBaseline(db, scope, by),
    ask: (q) => {
      const at = now();
      const id = uuid();
      ensureV2(db).questions.push({
        id, gap_id: null, intake_id: null, document_id: null, checkpoint_id: q.checkpoint_id, item_ref: q.item_ref, entity_id: null,
        module_key: null, category: "general", prompt: q.prompt, rationale: null, priority: 100, batch: null,
        asked_to: q.asked_to, asked_by: member?.id ?? db.user_id, section_key: null, status: "asked", created_at: at, updated_at: at,
      });
      return id;
    },
    asked: (id) => {
      const v2 = ensureV2(db);
      const q = v2.questions.find((x) => x.id === id);
      if (!q) return null;
      const a = v2.answers.filter((x) => x.question_id === id && x.kind === "answer").at(-1);
      return { status: q.status, answer: a?.body ?? null };
    },
    withdraw: (id) => {
      const q = ensureV2(db).questions.find((x) => x.id === id);
      if (q && (q.status === "asked" || q.status === "delegated")) Object.assign(q, { status: "withdrawn", updated_at: now() });
    },
    reviewChange: () => {
      const who = localStorage.getItem(MOCK_REVIEW_CHANGE_KEY);
      localStorage.removeItem(MOCK_REVIEW_CHANGE_KEY);
      return who;
    },
    undelivered: localStorage.getItem(MOCK_SCENARIO_KEY) === "undelivered",
    slowAgents: localStorage.getItem(MOCK_SCENARIO_KEY) === "slow-agents",
    feedback: db.feedback,
    documents: db.documents,
    confirmedGoals: () =>
      db.baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed").map((e) => ({ id: e.id, key: e.key, title: e.title })),
    suggestionStatus: (id) => withSuggestion(db.llm, { id } as FeedbackRow).suggestion?.status ?? null,
    staged: (id) => isStaged(withSuggestion(db.llm, { id } as FeedbackRow).suggestion),
    baselineReview: (runId, actions) => baselineReviewOf(db.baseline, runId, actions as Schemas["ReviewAction"][]),
    stagedText: (id) => {
      const s = withSuggestion(db.llm, { id } as FeedbackRow).suggestion;
      return s?.text ?? null;
    },
    lockedSections: (documentId, version) => {
      const v = db.versions.find((x) => x.document_id === documentId && x.number === version);
      return v ? lockedKeys(db, v) : [];
    },
    openProposals: (runId) => db.baseline.proposals.filter((p) => p.run_id === runId && p.status === "open").length,
    // B6: the confirmed and proposed goals not measurable, for an approved Confirm the baseline stop.
    vagueGoals: () =>
      db.baseline.entities.filter(
        (e) => e.type === "goal" && (e.status === "confirmed" || e.status === "proposed") && !goalCheck(e.attrs, e.status, (id) => activeMember(db, id)).measurable,
      ).length,
    latestVersion: (id) => {
      const doc = db.documents.find((d) => d.id === id);
      const vs = doc ? docVersions(db, doc) : [];
      return vs.length ? vs[vs.length - 1].number : null;
    },
    sectionKeys: (versionId) => db.versions.find((v) => v.id === versionId)?.sections.map((s) => s.section_key) ?? [],
    draftItemsToReuse: (documentId, version) => reusableDraftItems(draftDb(db), documentId, version),
    // The approved version a roadmap is built from: the one named, else the latest approved.
    sourceVersion: (documentId, number) => {
      const doc = findDocument(db, documentId)!;
      const vs = docVersions(db, doc);
      if (number != null) {
        const v = vs.find((x) => x.number === number);
        if (!v) return `version ${number} of '${doc.slug}' not found`;
        if (!v.approved_at) return `version ${number} of '${doc.slug}' is not approved: a roadmap is built from an approved PRD version`;
        if (nothingWritten(db, doc, v.sections)) return `version ${number} of '${doc.slug}': ${NOTHING_WRITTEN}`;
        return versionSource(doc, v);
      }
      const v = vs.filter((x) => x.approved_at).pop();
      if (v && nothingWritten(db, doc, v.sections)) return `version ${v.number} of '${doc.slug}': ${NOTHING_WRITTEN}`;
      return v ? versionSource(doc, v) : `'${doc.slug}' has no approved version: approve a version of the PRD before building its roadmap`;
    },
    // A run's draft becomes the next version: a copy of the latest one (or of the first
    // fixture for a new document); a roadmap draft is built from its PRD version. So the
    // review screens have something to show.
    importDraft: (slug, run) => {
      const prd = run.source ? db.versions.find((v) => v.id === run.source!.version_id) : undefined;
      const fromPrd =
        prd &&
        roadmapFromPrd({
          slug: run.source!.slug,
          title: run.source!.title,
          version: prd.number,
          sections: prd.sections.map((s) => ({ key: s.section_key, level: s.level, heading: s.heading })),
        });
      let doc = findDocument(db, slug);
      if (!doc) {
        doc = {
          id: uuid(),
          slug,
          title: fromPrd?.title ?? "Example product PRD",
          status: "draft",
          kind: run.document_kind ?? "prd",
          template: run.template ?? null,
          template_version: run.template ? "1" : null,
          theme: run.theme ?? null,
          created_at: now(),
          updated_at: now(),
        };
        db.documents.push(doc);
      }
      const latest = docVersions(db, doc).pop();
      const seed = (DOCUMENTS as DocumentSeed[])[0].versions[0];
      const number = (latest?.number ?? 0) + 1;
      // H8: an update_draft run writes the update for the period in its front matter.
      const period = latest?.front_matter.period as UpdatePeriod | undefined;
      // H9: a pricing_memo run writes the memo for the question in its front matter.
      const question = latest?.front_matter.question as string | undefined;
      if (doc.kind === "pricing" && question) {
        const window = (latest?.front_matter.evidence_window as EvidenceWindow | undefined) ?? { from: now().slice(0, 10), to: now().slice(0, 10) };
        const v = buildVersion(doc, { number, created_at: now(), sections: pricingDraftSections(doc.title, question, window), citations: [], brief: ["question", "recommendation", "options"] });
        v.front_matter = pricingFrontMatter(doc.slug, doc.title, question, window, DRAFT_OPTIONS);
        v.imported_by = "agent-track";
        db.versions.push(v);
        touch(db, doc.id);
        return { document_id: doc.id, slug: doc.slug, kind: doc.kind, version: v.number, source: null, prd_links: null };
      }
      if (doc.kind === "update" && isUpdateTemplate(doc.template) && period) {
        const v = buildVersion(doc, {
          number,
          created_at: now(),
          sections: draftSections(doc.template, doc.title, period),
          citations: UPDATE_SEED_CITATIONS,
          brief: updateFrontMatter(doc.template, doc.slug, doc.title, period).brief as string[],
        });
        v.front_matter = updateFrontMatter(doc.template, doc.slug, doc.title, period);
        v.imported_by = "agent-track";
        db.versions.push(v);
        touch(db, doc.id);
        return { document_id: doc.id, slug: doc.slug, kind: doc.kind, version: v.number, source: null, prd_links: null };
      }
      const base = fromPrd
        ? { number, created_at: now(), sections: fromPrd.sections, citations: [], brief: fromPrd.brief }
        : latest
          ? { number, created_at: now(), sections: latest.sections.map((x) => ({ key: x.section_key, level: x.level, heading: x.heading, body: x.body_md })), citations: [] }
          : { ...seed, number, created_at: now() };
      const v = buildVersion(doc, base);
      v.source = run.source ?? null;
      db.versions.push(v);
      queueDraft(db, doc.id, v);
      // D12: what Build next draft sent the agents: the text changes are applied in this
      // version and the agent-staged items leave Staged (the draft answers them).
      const sent = (run as SentRun).sent;
      for (const sug of db.llm?.suggestions ?? []) {
        if (sent?.suggestion_ids.includes(sug.id) && sug.status === "accepted")
          Object.assign(sug, { status: "applied", applied_in_version: v.number, updated_at: now() });
      }
      for (const f of db.feedback) {
        if (sent?.feedback_ids.includes(f.id)) Object.assign(f, { staged_for_agents_at: null, staged_for_agents_by: null });
      }
      touch(db, doc.id);
      return {
        document_id: doc.id,
        slug: doc.slug,
        kind: doc.kind,
        version: v.number,
        source: v.source,
        prd_links: prd ? prdLinks(v, run.source!.slug, prd) : null,
      };
    },
    uuid,
    now,
  };
}

function load(): Db {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Db;
    } catch {
      // fall through to a fresh seed
    }
  }
  const scenario = localStorage.getItem(MOCK_SCENARIO_KEY);
  const db = seeded(
    "db",
    scenario === "empty" ? seedEmpty : scenario === "large" ? seedLarge : scenario === "suggestions"
        ? seedSuggestions
        : scenario === "big-prd"
          ? seedBigPrd
          : scenario === "feature-set" || scenario === "run-discussions"
            ? seedFeatureSet
          : scenario === "baseline-review" || scenario === "baseline-review-console"
            ? () => seedBaselineReview(scenario === "baseline-review-console")
          : scenario === "scope-review"
            ? seedScopeReview
          : scenario === "eng-review" || scenario === DATE_BASES_SCENARIO
            ? seedEngReview
          : scenario === "eng-check"
            ? seedEngCheck
          : scenario === "eng-check-no-lead"
            ? seedEngCheckNoLead
          : scenario === "roadmap-items-console-held"
            ? seedRoadmapItemsConsoleHeld
          : scenario === "run-review"
            ? seedRunReview
          : scenario === "run-review-decider"
            ? seedRunReviewDecider
          : scenario === "priority-order"
            ? seedPriorityOrder
          : scenario === "next-draft" || scenario === "next-draft-costly"
            ? () => seedNextDraft(scenario === "next-draft-costly")
          : scenario === "before-drafting"
            ? seedBeforeDraftingScenario
          : scenario === "late-answers"
            ? seedLateAnswersScenario
          : scenario === "brief-goal-rejected"
            ? seedBriefGoalRejectedScenario
          : scenario === "questions"
            ? seedQuestions
            : scenario === "private-finding"
              ? seedPrivateFinding
              : scenario === "many-people"
                ? seedManyPeople
                : scenario === "strategy" || scenario === "strategy-no-vision"
                  ? () => seedStrategyScenario(scenario === "strategy")
                  : scenario === "strategy-none"
                    ? seedNoStrategyScenario
                    : seed,
  );
  // Revokes a disable could not make: none, unless a spec asks for them.
  db.revoke_failures = scenario === "revoke-failures" ? seedRevokeFailures() : [];
  db.access_failures = scenario === "access-failures" ? seedAccessFailures() : [];
  // Launches (H6): three synthetic launches in the "launches" scenario; none otherwise, so
  // other specs' Inbox counts stay as they were.
  if (scenario === "launches") {
    db.launches = seedLaunches(launchesContext(db, db.members.find((x) => x.id === db.user_id)!));
    // Launches are planned from an approved roadmap: usage-alerts-roadmap v1 is approved here,
    // so New launch (#344) has items to pick.
    const roadmap = db.documents.find((d) => d.slug === "usage-alerts-roadmap");
    const v1 = roadmap && db.versions.find((v) => v.document_id === roadmap.id && v.number === 1);
    if (roadmap && v1) {
      v1.approved_at = "2026-10-05T09:00:00Z";
      roadmap.status = "approved";
    }
  }
  // H9 Pricing input: a second owner, two pricing memos and made-up deals in the "pricing" scenario.
  if (scenario === "pricing") seedPricingScenario(db);
  // Outcomes (H3): synthetic predictions, one due for its check, in the "outcomes" scenario.
  // "outcomes-recorded" adds a verdict Oracle recorded (H11 at Act within limits) for the owner to change.
  if (scenario === "outcomes" || scenario === "outcomes-recorded") {
    const goal = db.baseline.entities.find((e) => e.type === "goal" && e.title === "Raise activation");
    const outcomes = goal ? seedOutcomes(db.user_id, goal.id, null) : [];
    if (goal && scenario === "outcomes-recorded") outcomes.push(seedOracleRecorded(db.user_id, goal.id));
    if (goal) db.quality = { outcomes, learnings: seedLearnings(db.user_id) };
  }
  db.autonomy = emptyAutonomy();
  // Discussions (G1): one private discussion in the "discussions" scenario; none otherwise,
  // so other specs' counts stay as they were.
  db.discussions =
    scenario === "discussions"
      ? seedDiscussionInboxScenario(db, seedDiscussionsScenario(db))
      : scenario === "discussion-replies" || scenario === POOL_SPENT_SCENARIO
        ? seedDiscussionsScenario(db, seedDiscussionReplies)
        : scenario === SLACK_SCENARIO
          ? seedDiscussionsScenario(db, seedSlackBridge)
          : scenario === "run-discussions"
            ? seedRunDiscussionsScenario(db)
            : scenario === "discussion-record"
              ? seedDiscussionRecordScenario(db)
              : emptyDiscussions();
  if (scenario === "oracle-did") db.autonomy.actions.push(seedOracleDid(db.user_id, uuid()));
  // #524: what Oracle did at Act within limits on a launch (H6) and a ritual (H2), each row
  // linking to its subject.
  if (scenario === "oracle-did-launch-ritual") {
    const owner = db.members.find((x) => x.id === db.user_id)!;
    db.launches = seedLaunches(launchesContext(db, owner));
    db.rituals = seedRituals(ritualsContext(db, owner), true);
    const launched = db.launches.launches.find((l) => l.state === "launched")!;
    const refresh = db.rituals.rituals.find((r) => r.kind === "roadmap_refresh")!;
    const occurrence = db.rituals.occurrences.find((o) => o.ritual_id === refresh.id)!;
    db.autonomy.actions.push(seedLaunchDid(db.user_id, uuid(), launched), seedRitualDid(db.user_id, uuid(), refresh, occurrence.id));
  }
  if (scenario === "proposal-noise") addNoisyProposals(db.baseline, uuid);
  // #347 "held-section-gone": a second held rewrite, of a section the latest version no longer has.
  if (scenario === "held-section-gone") {
    const prd = db.documents.find((d) => d.kind === "prd");
    db.review_v2 = seedReviewV2(prd, prd ? docVersions(db, prd).pop() : undefined, db.user_id, hash);
    const first = db.review_v2.patches[0];
    if (first) {
      db.review_v2.patches.push({
        ...first, id: "p0000000-0000-4000-8000-000000000002", section_key: "launch-checklist", heading: "Launch checklist",
        base_hash: hash("launch-checklist"), body_md: "Tell support a day before the cart change ships.",
      });
    }
  }
  if (scenario === "named-codes") {
    addGoalCodes(db.baseline);
    addCodedPrd(db);
    // An Inbox row quoting Oracle's text with a known code (G-B) and an unknown one (G-Z).
    db.autonomy.actions.push(seedOracleDid(db.user_id, uuid(), "Moved 'Saved addresses' up 2 within G-B, ahead of G-Z"));
  }
  if (scenario === "proposal-overlap") addOverlappingProposals(db.baseline, uuid);
  if (scenario === "goal-words") addGoalWords(db.baseline, db.members.find((m) => m.email === "approver@example.com")!.id);
  if (scenario === DIFF_SCENARIO) addRoadmapVersion(db);
  if (scenario === APPROVED_PLAN_SCENARIO) addApprovedPlan(db);
  if (scenario === VERSION_WARNINGS_SCENARIO) {
    const prd = db.documents.find((d) => d.slug === "usage-alerts");
    const roadmap = db.documents.find((d) => d.slug === "usage-alerts-roadmap");
    const v1 = roadmap && db.versions.find((v) => v.document_id === roadmap.id && v.number === 1);
    if (prd && v1) v1.warnings = versionWarnings(prd.title, prd.slug);
  }
  save(db);
  return db;
}

/** E3 "roadmap-diff": usage-alerts-roadmap v1 approved, then v2, a draft (./roadmap.ts gives each its items). */
function addRoadmapVersion(db: Db) {
  const doc = db.documents.find((d) => d.slug === "usage-alerts-roadmap");
  const v1 = doc && db.versions.find((v) => v.document_id === doc.id && v.number === 1);
  if (!doc || !v1) return;
  v1.approved_at ??= "2026-10-05T09:00:00Z";
  const v2 = structuredClone(v1);
  Object.assign(v2, { id: uuid(), number: 2, created_at: "2026-10-20T09:00:00Z", approved_at: null });
  v2.sections = v2.sections.map((s) => ({ ...s, id: uuid() }));
  db.versions.push(v2);
  doc.updated_at = v2.created_at;
}

/** E3b "approved-plan": usage-alerts-roadmap v1 approved, then usage-alerts v2, a draft with a Spend limits section (./draft-roadmap.ts gives it its items). */
function addApprovedPlan(db: Db) {
  const roadmap = db.documents.find((d) => d.slug === "usage-alerts-roadmap");
  const r1 = roadmap && db.versions.find((v) => v.document_id === roadmap.id && v.number === 1);
  const prd = db.documents.find((d) => d.slug === "usage-alerts");
  const p1 = prd && db.versions.find((v) => v.document_id === prd.id && v.number === 1);
  if (!roadmap || !r1 || !prd || !p1) return;
  r1.approved_at ??= "2026-10-05T09:00:00Z";
  roadmap.status = "approved";
  const p2 = structuredClone(p1);
  Object.assign(p2, { id: uuid(), number: 2, created_at: "2026-10-21T09:00:00Z", approved_at: null });
  const heading = "3. Spend limits";
  const body = "Admins set a monthly spend limit; Oracle warns at 80% of it.";
  p2.sections = [
    ...p2.sections.map((x) => ({ ...x, id: uuid() })),
    { ...p2.sections[p2.sections.length - 1], id: uuid(), section_key: "limits", ordinal: p2.sections.length, heading, body_md: body, body_text: body, content_hash: hash(`${heading}\n${body}`), citation_keys: [] },
  ];
  p2.content_hash = hash(p2.sections.map((x) => x.content_hash).join(""));
  db.versions.push(p2);
  prd.status = "in_review";
  prd.updated_at = p2.created_at;
}

/** "discussions": the commenter's private discussion with the approver on team-workspaces v2's Problem. */
function seedDiscussionsScenario(db: Db, seed: typeof seedDiscussions = seedDiscussions): DiscussionsDb {
  const doc = findDocument(db, "team-workspaces")!;
  const heading = findVersion(db, doc, 2)!.sections.find((s) => s.section_key === "problem")!.heading;
  return seed({ members: db.members, resolve: () => ({ status: 500, detail: "unused" }), uuid, now }, doc.id, `${doc.title} · ${heading}`, `/documents/${doc.slug}/v/2#problem`);
}

/** G6: the "discussions" seed plus the open discussion on saved-carts v2 whose rows wait in the Inbox. */
function seedDiscussionInboxScenario(db: Db, discussions: DiscussionsDb): DiscussionsDb {
  const doc = findDocument(db, "saved-carts")!;
  const ctx = { members: db.members, resolve: () => ({ status: 500, detail: "unused" }), uuid, now };
  seedDiscussionInbox(ctx, discussions, doc.id, doc.title, `/documents/${doc.slug}/v/2`);
  // Criterion 7: a question Oracle asked the approver from that discussion names it.
  const d = discussions.discussions.find((x) => x.document_id === doc.id)!;
  const at = "2026-10-21T08:25:00Z";
  ensureV2(db).questions.push({
    id: uuid(), gap_id: null, intake_id: null, document_id: doc.id, checkpoint_id: null, item_ref: null, entity_id: null,
    module_key: null, category: "general", prompt: "How long should a guest's cart last?", rationale: null, priority: 100,
    batch: null, asked_to: db.members.find((m) => m.email === "approver@example.com")!.id, asked_by: null, section_key: null,
    status: "asked", created_at: at, updated_at: at, discussion_id: d.id, discussion_title: d.title,
  });
  return discussions;
}

/** G3 "discussion-record": Oracle's proposed date basis in an open discussion on checkout-redesign v2's guest-checkout item. */
function seedDiscussionRecordScenario(db: Db): DiscussionsDb {
  const prd = findDocument(db, "checkout-redesign")!;
  return seedDiscussionRecord({ members: db.members, resolve: () => ({ status: 500, detail: "unused" }), uuid, now }, prd, 2);
}

/** The roadmap routes' context (CR-11, F3 Date bases) for the signed-in member. */
function roadmapContext(db: Db, me: { id: string; role: Role; email: string }): RoadmapContext {
  return {
    userId: me.id,
    role: me.role,
    engineeringLead: engineeringLeads(db).includes(me.id),
    leadNamed: engineeringLeads(db).length > 0,
    userName: me.email,
    documents: db.documents,
    versions: db.versions,
    approverId: db.members.find((x) => x.email === "approver@example.com")?.id,
    drafts: () => draftDb(db).rows,
  };
}

/** G5 "run-discussions": an open and a private discussion on the feature-set run's waiting checkpoint. */
function seedRunDiscussionsScenario(db: Db): DiscussionsDb {
  const run = db.runs!.runs.find((r) => r.id === FEATURE_SET_RUN)!;
  const cp = run.checkpoints.find((c) => c.status === "pending")!;
  const label = `${run.flow_title} · ${CHECKPOINT_NAMES[cp.kind] ?? cp.kind}`;
  return seedRunDiscussions({ members: db.members, resolve: () => ({ status: 500, detail: "unused" }), uuid, now }, { id: run.id, label, checkpoint_id: cp.id, checkpoint_kind: cp.kind });
}

const CHECKPOINT_NAMES: Record<string, string> = {
  baseline_confirm: "Confirm the baseline",
  feature_set: "Feature set",
  priority_order: "Priority order",
  prd_review: "PRD review",
  eng_review: "Engineering review",
  roadmap_items: "Roadmap items",
  roadmap_review: "Roadmap review",
  request_triage: "Request triage",
};

/** #406: the text of the document version a discussion is on, as oracle.discussions.context reads it: the section first (the brief on the whole document), then the rest, citation markers stripped. */
function discussionDocument(db: Db, d: DiscussionRow): DocumentSection[] {
  if (d.subject_kind !== "document" && d.subject_kind !== "section" && d.subject_kind !== "roadmap_item") return [];
  const doc = findDocument(db, String(d.subject.document_id));
  const v = doc ? findVersion(db, doc, Number(d.subject.version)) : undefined;
  if (!doc || !v) return [];
  const first = d.subject_kind === "section" ? String(d.subject.section_key) : null;
  const later = (x: (typeof v.sections)[number]) => Number(first ? x.section_key !== first : x.layer !== "brief");
  const sections = [...v.sections].sort((a, b) => later(a) - later(b));
  return sections.map((x) => ({
    document_id: doc.id,
    key: x.section_key,
    heading: x.heading,
    text: x.body_md.replace(/\s*\[c:[^\]]*\]/g, ""),
    url: `/documents/${doc.slug}/v/${v.number}#${x.section_key}`,
  }));
}

/** A discussion's subject as the API resolves it (oracle.discussions.service): documents, sections and run checkpoints are checked; other kinds are taken as given. */
function discussionSubject(db: Db, kind: string, s: Record<string, unknown>): SubjectInfo | { status: number; detail: string } {
  if (kind === "document" || kind === "section" || kind === "roadmap_item") {
    const doc = findDocument(db, String(s.document_id));
    if (!doc) return { status: 404, detail: "Document not found" };
    const v = findVersion(db, doc, Number(s.version));
    if (!v) return { status: 404, detail: `Version ${s.version} not found` };
    const url = `/documents/${doc.slug}/v/${v.number}`;
    if (kind === "document") return { key: `document:${doc.id}`, label: doc.title, url, document_id: doc.id };
    if (kind === "roadmap_item")
      return { key: `roadmap_item:${doc.id}:${s.item_key}`, label: `${doc.title} · ${s.item_key}`, url: `${url}/items`, document_id: doc.id };
    const section = v.sections.find((x) => x.section_key === s.section_key);
    if (!section) return { status: 422, detail: `Section ${s.section_key} is not in version ${v.number}` };
    return { key: `section:${doc.id}:${section.section_key}`, label: `${doc.title} · ${section.heading}`, url: `${url}#${section.section_key}`, document_id: doc.id };
  }
  if (kind === "checkpoint" || kind === "checkpoint_item") {
    const run = db.runs?.runs.find((r) => r.id === s.run_id);
    if (!run) return { status: 404, detail: "Run not found" };
    const cp = run.checkpoints.find((c) => c.id === s.checkpoint_id);
    if (!cp) return { status: 404, detail: "Checkpoint not found" };
    const label = `${run.flow_title} · ${CHECKPOINT_NAMES[cp.kind] ?? cp.kind}`;
    if (kind === "checkpoint") return { key: `checkpoint:${run.id}:${cp.kind}`, label, url: `/runs/${run.id}`, run_id: run.id };
    return { key: `run_item:${run.id}:${cp.kind}:${s.item_key}`, label: `${label} · ${s.item_key}`, url: `/runs/${run.id}`, run_id: run.id };
  }
  if (kind === "priorities") return { key: "priorities", label: "Priority order", url: "/priorities" };
  if (kind === "screen") return { key: `screen:${s.path}`, label: String(s.path), url: String(s.path) };
  const id = Object.values(s)[0];
  return { key: `${kind}:${id}`, label: kind.replace("_", " "), url: "/" };
}

/** An active member of this Oracle (a goal's owner must be one). */
function activeMember(db: Db, userId: string): boolean {
  return db.members.some((m) => m.id === userId && m.status !== "disabled");
}

/** /v1/baseline/... through ./baseline.ts, with the caller and the lookups it needs. */
function routeBaselineFor(db: Db, me: { id: string; role: Schemas["Me"]["role"] }, req: Request, p: string[], q: URLSearchParams) {
  const runOf = (runId: string): Schemas["ProposalRun"] | null => {
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const r = db.runs.runs.find((x) => x.id === runId);
    return r ? { id: r.id, flow: r.flow, flow_title: r.flow_title, status: r.status, created_at: r.created_at } : null;
  };
  const memberEmail = (userId: string) => db.members.find((m) => m.id === userId)?.email ?? null;
  return routeBaseline(db.baseline, { userId: me.id, role: me.role, runOf, memberEmail, sourceItem, isMember: (id) => activeMember(db, id) }, req, p.slice(2), q);
}

function save(db: Db) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

/** Drops all mock state (used by the "Reset mock data" control). */
export function resetMockData() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SOURCES_STORAGE_KEY);
}

// ---------------------------------------------------------------- domain helpers

function findDocument(db: Db, ref: string) {
  return db.documents.find((d) => d.slug === ref || d.id === ref);
}

function findVersion(db: Db, doc: DocumentRow, n: number) {
  return db.versions.find((v) => v.document_id === doc.id && v.number === n);
}

function docVersions(db: Db, doc: DocumentRow) {
  return db.versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);
}

function versionSource(doc: DocumentRow, v: VersionRow): Schemas["VersionSource"] {
  return {
    document_id: doc.id,
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    version: v.number,
    version_id: v.id,
    approved_at: v.approved_at,
  };
}

const DOC_LINK = /\]\((\/documents\/([A-Za-z0-9][\w.-]*)\/v\/(\d+)(?:#([A-Za-z0-9][\w.:-]*))?)\)/g;

/** A roadmap draft's links to its PRD version's sections, resolved or not (O4b). */
function prdLinks(v: VersionRow, slug: string, prd: VersionRow): Schemas["PrdLinks"] {
  const keys = new Set(prd.sections.map((s) => s.section_key));
  const out: Schemas["PrdLinks"] = { resolved: 0, unresolved: [] };
  for (const s of v.sections) {
    for (const m of s.body_md.matchAll(DOC_LINK)) {
      if (m[2] === slug && Number(m[3]) === prd.number && (!m[4] || keys.has(m[4]))) out.resolved += 1;
      else out.unresolved.push(m[1]);
    }
  }
  return out;
}

function summary(v: VersionRow): Schemas["VersionSummary"] {
  return {
    id: v.id,
    document_id: v.document_id,
    number: v.number,
    content_hash: v.content_hash,
    snapshot: v.snapshot,
    warnings: v.warnings,
    notes: v.notes,
    imported_by: v.imported_by,
    imported_by_name: v.imported_by_name,
    approved_at: v.approved_at,
    brief_source: v.brief_source ?? "none",
    source: v.source ?? null,
    created_at: v.created_at,
  };
}

function sectionLayer(db: Db, versionId: string, key: string): Schemas["SectionOut"]["layer"] | null {
  return db.versions.find((v) => v.id === versionId)?.sections.find((s) => s.section_key === key)?.layer ?? null;
}

function documentSummary(db: Db, d: DocumentRow): Schemas["DocumentSummary"] {
  const vs = docVersions(db, d);
  const latest = vs[vs.length - 1];
  const period = d.kind === "update" ? ((latest?.front_matter.period as UpdatePeriod | undefined) ?? null) : null;
  return {
    ...d,
    kind: d.kind ?? "prd",
    visibility: d.visibility ?? "company",
    period,
    latest_version: latest?.number ?? null,
    approved_version: vs.filter((v) => v.approved_at).pop()?.number ?? null,
    source: latest?.source ?? null,
  };
}

/** D10: the latest run review checkpoint whose import made version `number` of the document. */
function runReviewOf(db: Db, documentId: string, number: number) {
  const found = (db.runs?.runs ?? []).flatMap((run) => run.checkpoints.map((cp) => ({ run, cp })));
  return found.filter(({ cp }) => {
    const v = reviewedVersion(cp);
    return v?.document_id === documentId && v.version === number;
  }).pop();
}

/** D10: the designated decider of the document a run review reviews (its review policy), if any. */
function runReviewDecider(db: Db, cp: Pick<Schemas["CheckpointOut"], "kind" | "payload">): string | null {
  const v = reviewedVersion(cp);
  return (v && db.review_v2?.policies.find((x) => x.document_id === v.document_id)?.decider_id) || null;
}

/**
 * D10: a pending run review of `v` is approved once every section is approved, or `v` is
 * published. With a designated decider, the last section's approval counts only when the
 * decider gave it; otherwise the run review waits for them.
 */
function followRunReview(db: Db, doc: DocumentRow, v: VersionRow, published: boolean, by: string) {
  const found = runReviewOf(db, doc.id, v.number);
  if (!found || found.cp.status !== "pending" || !db.runs) return;
  const decider = runReviewDecider(db, found.cp);
  if (!published && decider && decider !== by) return;
  if (!published && !v.sections.every((x) => latestReview(db, v.id, x.section_key)?.verdict === "approved")) return;
  approveRunReview({ ...runsContext(db), db: db.runs }, found.run.id, found.cp.id);
}

function latestReview(db: Db, versionId: string, key: string): ReviewRow | undefined {
  return db.reviews
    .filter((r) => r.version_id === versionId && r.section_key === key)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .pop();
}

function versionOut(db: Db, v: VersionRow): Schemas["VersionOut"] {
  // E1: the version's draft roadmap summary (PRD versions only), for the Roadmap tab's label.
  const doc = db.documents.find((d) => d.id === v.document_id);
  const draft_roadmap = draftRoadmapSummary(doc?.kind === "prd" ? draftDb(db) : undefined, doc, v.number);
  const out: Schemas["VersionOut"] = {
    ...v,
    date_marks: [],
    sections: v.sections.map((s) => {
      const r = latestReview(db, v.id, s.section_key);
      return {
        ...s,
        revision: sectionRevision(s, hash),
        spec_states: s.spec_states ?? [],
        verdict: r
          ? {
              verdict: r.verdict,
              note: r.note,
              reviewer_id: r.reviewer_id,
              created_at: r.created_at,
              // An approval that lapsed (C2): set on a stored review by the specs.
              ...(r.lapsed_at ? { lapsed_at: r.lapsed_at, lapse_reason: r.lapse_reason ?? null } : {}),
            }
          : null,
      };
    }),
  };
  return Object.assign(out, { draft_roadmap });
}

/** E1: the draft roadmaps' context: the signed-in member (role override included) and the mock's runs. */
function draftCtx(db: Db): DraftRoadmapContext {
  const member = db.members.find((x) => x.email === sessionOf(db)) ?? db.members.find((m) => m.id === db.user_id)!;
  const me = withMockRole(member);
  return {
    role: me.role,
    userId: me.id,
    documents: db.documents,
    versions: db.versions,
    members: db.members,
    uuid,
    now,
    runs: () => (db.runs ??= seeded("runs", () => seedRuns(runsContext(db)))),
  };
}

function draftDb(db: Db): DraftRoadmapDb {
  return (db.draft_roadmaps ??= seeded("draft-roadmaps", () => {
    const drafts = seedDraftRoadmaps(draftCtx(db));
    if (localStorage.getItem(MOCK_SCENARIO_KEY) === APPROVED_PLAN_SCENARIO) seedApprovedPlanDraft(draftCtx(db), drafts);
    return drafts;
  }));
}

/** E1: a new PRD version queues its items-only roadmap (the API's version_imported handler). */
function queueDraft(db: Db, documentId: string, v: VersionRow, origin?: "skeleton") {
  const doc = db.documents.find((d) => d.id === documentId);
  if (!doc || doc.kind !== "prd") return;
  const by = db.members.find((x) => x.email === sessionOf(db))?.id ?? null;
  queueDraftRoadmap({ now }, draftDb(db), doc, v, by, origin);
}

function commentOut(db: Db, c: CommentRow): Schemas["CommentOut"] {
  return {
    ...c,
    layer: sectionLayer(db, c.version_id, c.section_key),
    replies: db.comments
      .filter((r) => r.parent_id === c.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => commentOut(db, r)),
  };
}

function truncate(text: string, n = 140) {
  return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
}

function touch(db: Db, documentId: string) {
  const d = db.documents.find((x) => x.id === documentId);
  if (!d) return;
  d.updated_at = now();
  if (d.status === "draft") d.status = "in_review";
}

function addComment(
  db: Db,
  v: VersionRow,
  body: Schemas["CommentCreate"],
  opts?: { created_at?: string; author_id?: string },
) {
  const created_at = opts?.created_at ?? now();
  const feedbackId = uuid();
  const c: CommentRow = {
    id: uuid(),
    version_id: v.id,
    section_key: body.section_key,
    anchor: body.anchor,
    body: body.body,
    author_id: opts?.author_id ?? db.user_id,
    parent_id: null,
    resolved_at: null,
    created_at,
    feedback_item_id: feedbackId,
  };
  db.comments.push(c);
  db.feedback.push({
    id: feedbackId,
    document_id: v.document_id,
    raised_on_version: v.number,
    kind: "comment",
    comment_id: c.id,
    section_key: body.section_key,
    summary: truncate(body.body),
    author_id: c.author_id,
    anchor: body.anchor,
    verdict: null,
    status: "open",
    addressed_in_version: null,
    resolution_note: null,
    created_at,
    updated_at: created_at,
  });
  return c;
}

function addReview(
  db: Db,
  v: VersionRow,
  key: string,
  body: Schemas["SectionReviewIn"],
  opts?: { created_at?: string; reviewer_id?: string },
): ReviewRow {
  const created_at = opts?.created_at ?? now();
  // As the API does: a later verdict on the same section supersedes the open verdict
  // items raised on this or an earlier version.
  for (const f of db.feedback) {
    if (
      f.kind === "section_review" &&
      f.document_id === v.document_id &&
      f.raised_on_version <= v.number &&
      f.section_key === key &&
      f.status === "open"
    ) {
      f.status = "superseded";
      f.resolution_note = `Superseded by a later '${body.verdict}' verdict on version ${v.number}`;
      f.updated_at = created_at;
    }
  }
  const r: ReviewRow = {
    id: uuid(),
    version_id: v.id,
    section_key: key,
    verdict: body.verdict,
    note: body.note ?? null,
    reviewer_id: opts?.reviewer_id ?? db.user_id,
    created_at,
    feedback_item_id: null,
  };
  if (body.verdict !== "approved") {
    const heading = v.sections.find((s) => s.section_key === key)?.heading ?? key;
    r.feedback_item_id = uuid();
    db.feedback.push({
      id: r.feedback_item_id,
      document_id: v.document_id,
      raised_on_version: v.number,
      kind: "section_review",
      comment_id: null,
      section_review_id: r.id,
      section_key: key,
      summary: truncate(
        body.note?.trim() || `${body.verdict === "rejected" ? "Rejected" : "Changes requested on"} ${heading}`,
      ),
      author_id: r.reviewer_id,
      anchor: null,
      verdict: body.verdict,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      created_at,
      updated_at: created_at,
    });
  }
  db.reviews.push(r);
  return r;
}

function lockedKeys(db: Db, v: VersionRow): string[] {
  return v.sections
    .filter((s) => latestReview(db, v.id, s.section_key)?.verdict === "approved")
    .map((s) => s.section_key);
}

function versionMarkdown(doc: DocumentRow, v: VersionRow): string {
  const cites = v.citations
    .map(
      (c) =>
        `  - id: ${c.cite_key}\n    source: ${c.source}\n    ref: ${c.ref}\n    title: ${JSON.stringify(c.title ?? "")}\n    excerpt: ${JSON.stringify(c.excerpt ?? "")}` +
        (c.item_id ? `\n    item: ${c.item_id}` : "") +
        (c.confidence != null ? `\n    confidence: ${c.confidence}` : "") +
        (c.confidence_note ? `\n    confidence_note: ${JSON.stringify(c.confidence_note)}` : "") +
        (c.low_confidence ? "\n    low_confidence: true" : ""),
    )
    .join("\n");
  const period = v.front_matter.period as UpdatePeriod | undefined;
  const update = doc.kind === "update" ? `kind: update\ntemplate: ${doc.template}\n${period ? `period: {from: ${period.from}, to: ${period.to}}\n` : ""}` : "";
  const head = `---\ndocument: ${doc.slug}\ntitle: ${doc.title}\n${update}${v.snapshot ? `snapshot: ${v.snapshot}\n` : ""}citations:\n${cites || "  []"}\n---\n`;
  const body = v.sections
    .map((s) => `${"#".repeat(s.level)} ${s.heading} {#${s.section_key}}\n\n${s.body_md}\n`)
    .join("\n");
  return `${head}\n${body}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function banner(doc: DocumentRow, v: VersionRow) {
  const status = v.approved_at ? "approved" : doc.status;
  return `${doc.title} · version ${v.number} · ${status} · ${(v.approved_at ?? v.created_at).slice(0, 10)}`;
}

function exportHtml(doc: DocumentRow, v: VersionRow): string {
  const sections = v.sections
    .map((s) => {
      const tag = `h${Math.min(s.level, 3)}`;
      const paras = s.body_text
        .split(/\n\n+/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      return `<section id="${s.section_key}"><${tag}>${escapeHtml(s.heading)}</${tag}>${paras}</section>`;
    })
    .join("\n");
  const notes = v.citations
    // As the API's export: an "oracle" citation's ref names a baseline item, not a link.
    .map((c) =>
      c.source === "oracle"
        ? `<li>${escapeHtml(c.title ?? c.ref)} <span>${escapeHtml(c.ref)}</span> (${c.source})</li>`
        : `<li><a href="${escapeHtml(c.ref)}">${escapeHtml(c.title ?? c.ref)}</a> (${c.source})</li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)} v${v.number}</title></head><body><p class="banner">${escapeHtml(banner(doc, v))} · mock export</p>${sections}<ol class="citations">${notes}</ol></body></html>`;
}

/** A tiny single-page PDF (Helvetica, ASCII only) so the download flow can be exercised. */
function exportPdf(doc: DocumentRow, v: VersionRow): string {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1");
  const lines = [banner(doc, v), "Mock export: the API renders the real PDF.", "", ...v.sections.map((s) => s.heading)];
  const text = lines.map((l, i) => `${i ? "T* " : ""}(${ascii(l)}) Tj`).join("\n");
  const stream = `BT /F1 11 Tf 16 TL 72 740 Td\n${text}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

// ---------------------------------------------------------------- routing

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

const notFound = (what: string) => json(404, { detail: `${what} not found` });

const ROLE_ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
const APPROVER_INVITES = "Approvers invite viewers and commenters. Ask an owner to invite an approver.";
const forbidden = (min: Role) => json(403, { detail: `Requires the ${min} role` });

function meOut(db: Db, m: MemberRow): Schemas["Me"] {
  // A5: the roles they may invite with (owners any, approvers viewer and commenter).
  const invite_roles: Role[] = m.role === "owner" ? ROLE_ORDER : m.role === "approver" ? ["viewer", "commenter"] : [];
  return {
    kind: "user",
    tenant_id: db.tenant_id,
    user_id: m.id,
    email: m.email,
    role: m.role,
    engineering_lead: !!m.engineering_lead,
    name: m.name ?? null,
    invite_roles,
    company_timezone: String(mockSettingValue("company_timezone") ?? "America/Los_Angeles"),
  };
}

/** A3, as oracle.members.leads: the active members carrying the engineering lead flag. */
function engineeringLeads(db: Db): string[] {
  return db.members.filter((x) => x.engineering_lead && x.status !== "disabled").map((x) => x.id);
}

const VIEWER_REFUSED = "A viewer can't be the engineering lead. Make them a commenter or above first.";

/**
 * GET /v1/setup (A1), as oracle.setup: the caller's steps from the mock's own stores. The
 * connections and sources stores are the company's in the mock, not each person's.
 */
function setupOut(db: Db, me: MemberRow): Schemas["SetupOut"] {
  const facts = setupFacts();
  const sources = sourceCount();
  const people = db.members.filter((x) => x.status !== "disabled").length;
  const invites = db.invites.filter((i) => i.status === "open").length;
  const built = lastBaselineBuild(db.runs);
  const personal: Schemas["SetupStep"][] = [
    { key: "connect", done: facts.connections > 0, count: facts.connections, detail: null },
    { key: "sources", done: sources > 0, count: sources, detail: null },
  ];
  const owner: Schemas["SetupStep"][] = [
    { key: "invite", done: people >= 2 || invites >= 1, count: people, detail: null },
    {
      key: "domains",
      done: facts.domains.length > 0,
      count: facts.domains.length,
      detail: facts.domains.length === 1 ? facts.domains[0] : null,
    },
    { key: "eng_lead", done: engineeringLeads(db).length > 0, count: engineeringLeads(db).length, detail: null },
    { key: "horizons", done: facts.horizons, count: null, detail: null },
    { key: "timezone", done: facts.timezone != null, count: null, detail: facts.timezone },
    { key: "build_baseline", done: built != null, count: null, detail: built },
  ];
  // The "setup-new-step" scenario: an API with a step this web build has no words for.
  if (localStorage.getItem(MOCK_SCENARIO_KEY) === "setup-new-step") {
    owner.push({ key: "calendar" as Schemas["SetupStep"]["key"], done: false, count: null, detail: null });
  }
  const steps = me.role === "owner" ? [...personal, ...owner] : me.role === "viewer" ? [] : personal;
  return {
    steps,
    done: steps.filter((st) => st.done).length,
    total: steps.length,
    hidden: db.preferences?.[me.email]?.setup_hidden === true,
  };
}

/** Where an invitee signs in with Google: the app's own address in the mock. */
const signInUrl = () => `${location.origin}/`;
/** The mock company's sign-in domains (ORACLE_IAP_ALLOWED_DOMAINS). */
const SIGN_IN_DOMAINS = ["example.com"];
/** A queued invite email goes out (or fails) this long after it was queued. */
const MAIL_DELAY_MS = 400;

/** How long a Retry of an invite's access takes (Google's IAP API). */
const RETRY_DELAY_MS = 600;
/** What Oracle records of Google refusing an invite's IAP access (#330): a plus address is
 * no Google account of its own, so Google answers 400 with its own message. */
const iapRefusal = (email: string) =>
  email.includes("+")
    ? `oracle-api-be: Google returned 400 (bad request): User ${email} does not exist.`
    : "oracle-api-be: Google returned 403 (permission denied)";

/** A5: the scenarios that sign in with Google as someone who is not a member (GET /v1/auth/access). */
const ACCESS_SCENARIOS: Record<string, Schemas["AccessStateOut"]["state"]> = {
  "access-pending": "pending",
  "access-declined": "declined",
  "access-invite-only": "invite_only",
  "access-expired": "invite_expired",
  "access-outside": "outside_domains",
};
const ACCESS_EMAIL = "new.person@example.com";

/** An open invite past its expiry (A5): still a row, with Resend. */
const expired = (i: InviteRow) => i.status === "open" && !!i.expires_at && Date.parse(i.expires_at) < Date.now();

/** The background send: queued invite emails whose time has come are sent, or fail. */
function settleInviteEmails(db: Db) {
  const fails = localStorage.getItem(MOCK_SCENARIO_KEY) === "mail-fails";
  for (const i of db.invites) {
    if (i.email_status !== "queued" || Date.now() - Date.parse(i.email_at ?? "") < MAIL_DELAY_MS) continue;
    const resent = (db.invites_resent ??= []).includes(i.id);
    if (fails && !resent) Object.assign(i, { email_status: "failed", email_error: "the Gmail API answered 503", email_at: now() });
    else Object.assign(i, { email_status: "sent", email_error: null, email_at: now() });
  }
}

type AccessRequestRow = Schemas["AccessRequestOut"];

/** The A5 access requests, seeded once per mock db (one pending: new.person@example.com). */
function accessRequests(db: Db): AccessRequestRow[] {
  return (db.access_requests ??= MOCK_ACCESS_REQUESTS.map((r) => ({ ...r, id: uuid(), status: "pending" as const, last_seen_at: r.last_seen_at })));
}

/** As oracle.members.access.preset_role: the stored default role when `roles` has it, else the least of them. */
function presetRole(roles: readonly Role[]): Role | null {
  if (!roles.length) return null;
  const stored = String(mockSettingValue("iap_default_role") ?? "commenter") as Role;
  return roles.includes(stored) ? stored : roles[0];
}

/** The Inbox's access request rows (A5): pending ones, oldest first, for those who may approve them. */
function inboxAccessRequests(db: Db, me: MemberRow): Schemas["InboxAccessRequest"][] {
  const roles = meOut(db, me).invite_roles;
  const preset = presetRole(roles);
  if (!preset) return [];
  return accessRequests(db)
    .filter((r) => r.status === "pending")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((r) => ({ id: r.id, email: r.email, note: r.note ?? null, requested_at: r.created_at, last_seen_at: r.last_seen_at, default_role: preset, roles }));
}

/**
 * Members: owners only, as in the API. Invites and access requests (A5): approvers too, with
 * their invite_roles (viewer and commenter), and only the invites they sent.
 */
async function membersRoute(db: Db, req: Request, p: string[], me: MemberRow): Promise<Response> {
  const m = req.method;
  const owner = atLeast(me.role, "owner");
  if (!owner && (p[1] === "members" || !atLeast(me.role, "approver"))) return forbidden(p[1] === "members" ? "owner" : "approver");
  const inviteRoles = meOut(db, me).invite_roles;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const account = (db.account ??= seedAccount(db.members, uuid));
  const out = (x: MemberRow): MemberRow => ({ ...x, open_tokens: openTokens(account, x.id) });
  const detailCtx: MembersContext = { db, me, uuid, now, openTokens: (id) => openTokens(account, id), credentials: (id) => liveCredentials(account, id) };
  if (p[1] === "members") {
    if (!p[2] && m === "GET") return json(200, db.members.map(out));
    // A5: a member's detail, the preview of a change, and hand-over (./members.ts).
    const detail = await membersDetailRoute(detailCtx, req, p);
    if (detail) return detail;
    const target = db.members.find((x) => x.id === p[2]);
    if (!target) return notFound("Member");
    // A disabled owner is not another owner.
    const otherOwner = db.members.some((x) => x.id !== target.id && x.role === "owner" && x.status !== "disabled");
    if (m === "PATCH") {
      // A role, the engineering lead flag (A3), or both: role first.
      const { role, engineering_lead: lead, name, hand_over } = await body<Schemas["MemberPatch"] & { hand_over?: HandOver[] }>();
      if (role == null && lead == null && name === undefined) return json(422, { detail: "Send role, engineering_lead, name or more" });
      if (name != null && name.trim().length > 80) return json(422, { detail: "A name is at most 80 characters" });
      const nextRole = role ?? target.role;
      if (role != null && target.role === "owner" && role !== "owner" && target.status !== "disabled" && !otherOwner) {
        return json(409, { detail: "Cannot demote the last owner; make someone else owner" });
      }
      if (lead && nextRole === "viewer") return json(422, { detail: VIEWER_REFUSED });
      // A5: hand-over first, then the role change; a refused move changes nothing.
      const refused = handOver(detailCtx, target.id, hand_over);
      if (refused) return refused;
      if (name !== undefined) target.name = name?.trim() || null;
      if (role != null && role !== target.role) applied(detailCtx, { ...target, role }, "role");
      target.role = nextRole;
      // A viewer never carries the flag: a demotion to viewer clears it.
      if (nextRole === "viewer") target.engineering_lead = false;
      if (lead != null) target.engineering_lead = lead;
      return json(200, out(target));
    }
    // Removing a member disables them (C2): the row stays; an owner can restore them.
    if ((m === "POST" && p[3] === "disable") || (m === "DELETE" && !p[3])) {
      if (target.status !== "disabled") {
        if (target.id === me.id) {
          return json(409, { detail: "You cannot remove yourself; another owner can remove you" });
        }
        if (target.role === "owner" && !otherOwner) {
          return json(409, { detail: "Cannot remove the last owner; make someone else owner" });
        }
        // A5: the hand-over applies first, then the disable; a refused move removes no one.
        const input = m === "POST" ? await body<{ hand_over?: HandOver[] } | null>() : null;
        const refused = handOver(detailCtx, target.id, input?.hand_over);
        if (refused) return refused;
        applied(detailCtx, target, "remove");
        Object.assign(target, { status: "disabled", disabled_at: now(), disabled_by: me.id });
        // Their Google IAP access is taken away; in "iap-revoke-fails" Google refuses, and
        // the revoke is owed (the tick retries it).
        if (localStorage.getItem(MOCK_SCENARIO_KEY) === "iap-revoke-fails") target.access_pending = "revoke";
        // Every credential acting for them is revoked with the disable.
        revokeMemberTokens(account, target.id, target.disabled_at!);
        for (const i of db.invites) {
          if (i.email === target.email && i.status === "open") Object.assign(i, { status: "revoked", revoked_at: now() });
        }
      }
      return m === "DELETE" ? json(204, undefined) : json(200, out(target));
    }
    if (m === "POST" && p[3] === "restore") {
      Object.assign(target, { status: "active", disabled_at: null, disabled_by: null, access_pending: null });
      return json(200, out(target));
    }
  }
  if (p[1] === "access-requests") {
    // A5, as oracle.members.access: approve makes an open invite (14 days), decline
    // turns it down, reopen (Undo) puts it back to pending and revokes an unclaimed invite.
    const rows = accessRequests(db);
    // As the API's preset_role: the stored default role when the caller may approve as it.
    const withPreset = (r: AccessRequestRow): AccessRequestRow => ({ ...r, default_role: presetRole(inviteRoles) });
    if (!p[2] && m === "GET") {
      const status = new URL(req.url).searchParams.get("status") ?? "pending";
      return json(200, rows.filter((r) => status === "all" || r.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(withPreset));
    }
    const row = rows.find((r) => r.id === p[2]);
    if (!row) return notFound("Access request");
    if (p[3] === "approve" && m === "POST") {
      if (row.status !== "pending") return json(409, { detail: `This request was already ${row.status}` });
      const { role, name } = await body<Schemas["AccessApprove"]>();
      if (!inviteRoles.includes(role)) return json(403, { detail: APPROVER_INVITES });
      const invite: InviteRow = {
        id: uuid(),
        email: row.email,
        name: name ?? null,
        role,
        engineering_lead: false,
        status: "open",
        invited_by: me.id,
        created_at: now(),
        accepted_at: null,
        revoked_at: null,
        access: "granted",
        access_error: null,
        access_at: now(),
        email_status: "queued",
        email_at: now(),
        sign_in_url: signInUrl(),
        expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        resend_count: 0,
        access_request_id: row.id,
      };
      db.invites.unshift(invite);
      Object.assign(row, { status: "approved", role, invite_id: invite.id, decided_by: me.id, decided_at: now() });
      return json(200, withPreset(row));
    }
    if (p[3] === "decline" && m === "POST") {
      if (row.status !== "pending") return json(409, { detail: `This request was already ${row.status}` });
      Object.assign(row, { status: "declined", decided_by: me.id, decided_at: now() });
      return json(200, withPreset(row));
    }
    if (p[3] === "reopen" && m === "POST") {
      if (row.status !== "approved" && row.status !== "declined") return json(409, { detail: `This request is ${row.status}` });
      const invite = db.invites.find((i) => i.id === row.invite_id);
      // Approvers revoke only the invites they sent.
      if (invite && !invite.revoked_at && me.role !== "owner" && invite.invited_by !== me.id)
        return json(403, { detail: "Another person approved this request; ask an owner to undo it" });
      if (invite) Object.assign(invite, { status: "revoked", revoked_at: now() });
      Object.assign(row, { status: "pending", role: null, invite_id: null, decided_by: null, decided_at: null });
      return json(200, withPreset(row));
    }
  }
  if (p[1] === "invites") {
    settleInviteEmails(db);
    // As invites_out: each invite with who sent it, by name (the email when they have none).
    const withInviter = (i: InviteRow): InviteRow => {
      const by = db.members.find((x) => x.id === i.invited_by);
      return { ...i, invited_by_name: by ? by.name || by.email : null };
    };
    const scenario = localStorage.getItem(MOCK_SCENARIO_KEY);
    if (!p[2] && m === "GET") {
      const status = new URL(req.url).searchParams.get("status") ?? "open";
      return json(
        200,
        db.invites
          // A5: an open invite past its expiry reads expired; ?status=open lists both (each needs an action).
          .map((i) => (expired(i) ? { ...i, status: "expired" as const } : i))
          .map(withInviter)
          .filter((i) => (status === "all" || i.status === status || (status === "open" && i.status === "expired")) && (owner || i.invited_by === me.id))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    }
    if (!p[2] && m === "POST") {
      const input = await body<Schemas["InviteCreate"]>();
      const email = input.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(422, { detail: "Not an email address" });
      if (!inviteRoles.includes(input.role)) return json(403, { detail: APPROVER_INVITES });
      if (input.engineering_lead && input.role === "viewer") return json(422, { detail: VIEWER_REFUSED });
      if ((input.message?.length ?? 0) > 500) return json(422, { detail: "The message is longer than 500 characters" });
      if (!SIGN_IN_DOMAINS.includes(email.split("@")[1])) {
        // A5 (3.4): the API's outside_company_domains refusal.
        return json(422, {
          detail: `${email} is outside the company's email domains (${SIGN_IN_DOMAINS.join(", ")}), so Google sign-in can't let them join. Add the domain under Sign-in first.`,
        });
      }
      if (db.members.some((x) => x.email === email)) return json(409, { detail: `${email} is already a member` });
      const before = db.invites.find((i) => i.email === email && i.status === "open");
      if (before && expired(before)) return json(409, { detail: `${email} has an expired invite; resend it` });
      if (before) return json(409, { detail: `${email} already has an open invite; revoke it first` });
      const invite: InviteRow = {
        id: uuid(),
        email,
        // A5: how teammates know them; the member takes it at their first sign-in.
        name: input.name?.trim() || null,
        role: input.role,
        engineering_lead: !!input.engineering_lead,
        status: "open",
        invited_by: me.id,
        created_at: now(),
        accepted_at: null,
        revoked_at: null,
        ...(scenario === "iap-pending" || email.includes("+")
          ? { access: "pending", access_error: iapRefusal(email) }
          : { access: "granted", access_error: null }),
        access_at: now(),
        email_status: scenario === "mail-off" ? "not_sent" : "queued",
        email_at: now(),
        sign_in_url: signInUrl(),
        expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        resend_count: 0,
        message: input.message?.trim() || null,
      };
      db.invites.push(invite);
      return json(201, withInviter(invite));
    }
    // Approvers act on their own invites only; another's is not found.
    const invite = db.invites.find((i) => i.id === p[2] && (owner || i.invited_by === me.id));
    if (!invite) return notFound("Invite");
    if (!owner && m === "POST" && (p[3] === "access" || p[3] === "email")) return forbidden("owner");
    // A5: Resend gives an open or expired invite 14 more days.
    if (m === "POST" && p[3] === "resend") {
      if (invite.status !== "open") return json(409, { detail: `This invite was ${invite.status}; invite them again` });
      Object.assign(invite, {
        expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        resent_at: now(),
        resend_count: (invite.resend_count ?? 0) + 1,
      });
      return json(200, withInviter(invite));
    }
    if (m === "POST" && (p[3] === "access" || p[3] === "email")) {
      if (invite.status !== "open") return json(409, { detail: `This invite was ${invite.status}; invite them again` });
      if (p[3] === "access") {
        // The grant is Google's IAP API under way: it takes a moment.
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        Object.assign(
          invite,
          invite.email.includes("+")
            ? { access: "pending", access_error: iapRefusal(invite.email), access_at: now() }
            : { access: "granted", access_error: null, access_at: now() },
        );
      }
      else if (invite.email_status === "queued") return json(409, { detail: "Oracle is sending this invite's email" });
      else if (invite.email_status === "sent" && invite.email_at && Date.now() - Date.parse(invite.email_at) < 60_000) {
        const wait = Math.ceil((60_000 - (Date.now() - Date.parse(invite.email_at))) / 1000);
        return json(429, { detail: `Oracle emailed this invite under a minute ago; resend it in ${wait} seconds` });
      } else {
        (db.invites_resent ??= []).push(invite.id);
        Object.assign(invite, { email_status: scenario === "mail-off" ? "not_sent" : "queued", email_error: null, email_at: now() });
      }
      return json(200, withInviter(invite));
    }
    if (m === "DELETE") {
      if (invite.status === "accepted") return json(409, { detail: "This invite was already accepted" });
      if (invite.status === "open") Object.assign(invite, { status: "revoked", revoked_at: now() });
      return json(204, undefined);
    }
  }
  return notFound("Route");
}

/** #346: the change-set mock's view of the db; a proposal imports the next version, copied from its base. */
function planEditsContext(db: Db, me: { id: string; role: Role }): PlanEditsContext {
  return {
    userId: me.id,
    role: me.role,
    documents: db.documents,
    versions: db.versions,
    uuid,
    now,
    deciderOf: (id) => db.review_v2?.policies.find((x) => x.document_id === id)?.decider_id ?? null,
    seededItems: seededPlanItems,
    // The Plan mock's usage-alerts-roadmap v1 is its approved plan (./roadmap.ts, ALERTS_APPROVED).
    seededApproved: (slug) => (slug === ALERTS_ROADMAP_SLUG ? 1 : null),
    newVersion: (doc, base, body) => {
      const row = db.versions.find((v) => v.id === base.id)!;
      const document = db.documents.find((d) => d.id === doc.id)!;
      const kept = row.sections.filter((s) => s.section_key !== "plan-changes");
      const at = kept.findIndex((s) => s.section_key === "sources");
      const added = {
        ...kept[0], id: uuid(), section_key: "plan-changes", level: 2, heading: "Plan changes", body_md: body,
        body_text: plainText(body), content_hash: hash("Plan changes\n" + body), citation_keys: [], layer: "detail" as const, notes: null, spec_states: [],
      };
      const sections = (at < 0 ? [...kept, added] : [...kept.slice(0, at), added, ...kept.slice(at)]).map((s, ordinal) => ({ ...s, ordinal }));
      const number = Math.max(...docVersions(db, document).map((v) => v.number)) + 1;
      const next: VersionRow = {
        ...structuredClone(row), id: uuid(), number, approved_at: null, approval_lapses: [], created_at: now(),
        imported_by: me.id, sections, content_hash: hash(sections.map((s) => s.content_hash).join("")),
      };
      db.versions.push(next);
      document.status = "in_review";
      document.updated_at = now();
      return next;
    },
  };
}

/** The v2 review mock's view of the db; a section save copies the latest version. */
function reviewV2Context(db: Db, userId: string, role: Role) {
  return {
    db: db.review_v2!,
    documents: db.documents,
    versions: db.versions,
    reviews: db.reviews,
    me: { id: userId, role },
    uuid,
    now,
    hash,
    exportHtml: (doc: { id: string }, v: { id: string }) =>
      exportHtml(db.documents.find((d) => d.id === doc.id)!, db.versions.find((x) => x.id === v.id)!),
    editSection: (doc: { id: string }, key: string, heading: string | null, bodyMd: string) => {
      const latest = docVersions(db, db.documents.find((d) => d.id === doc.id)!).pop()!;
      const sections = latest.sections.map((s) =>
        s.section_key === key
          ? { ...s, id: uuid(), heading: heading ?? s.heading, body_md: bodyMd, body_text: plainText(bodyMd), content_hash: hash(`${s.level}\n${heading ?? s.heading}\n${bodyMd}`) }
          : { ...s, id: uuid() },
      );
      const next: VersionRow = {
        ...latest,
        id: uuid(),
        number: latest.number + 1,
        content_hash: hash(sections.map((s) => s.content_hash).join(":")),
        approved_at: null,
        approval_lapses: [],
        warnings: [],
        created_at: now(),
        sections,
      };
      db.versions.push(next);
      queueDraft(db, doc.id, next);
      touch(db, doc.id);
      return versionOut(db, next);
    },
  };
}

/**
 * The PRDs in review trace to the baseline: their goal-trace and scope sections link the
 * goals and features they serve, so Home and the trace show goal tags.
 */
function goalLinks(db: Db): V2Db["section_links"] {
  const out: V2Db["section_links"] = [];
  const link = (slug: string, section: string, entityKey: string) => {
    const doc = findDocument(db, slug);
    const v = doc && docVersions(db, doc).at(-1);
    const e = db.baseline.entities.find((x) => x.key === entityKey);
    if (!doc || !v || !e || !v.sections.some((s) => s.section_key === section)) return;
    out.push({
      id: uuid(), document_id: doc.id, version_id: v.id, section_key: section, section_hash: null, composition_revision: null,
      module_key: null, kind: "implements", entity_id: e.id, evidence_id: null, source_item_id: null, precision: "section",
      claim: null, created_by: null, created_at: v.created_at,
    });
  };
  link("checkout-redesign", "goal-trace", "g.activation");
  link("checkout-redesign", "goal-trace", "g.paid-conversion");
  link("team-workspaces", "scope", "f.team-invites");
  return out;
}

/** The v2 rows, seeded on first use against the first mock PRD. */
/** Every use of a source item (A2 coverage): baseline evidence, citations and section links. */
function itemUses(db: Db): Schemas["UsedIn"][] {
  const uses: Schemas["UsedIn"][] = [];
  const entity = (id: string | null | undefined) => db.baseline.entities.find((e) => e.id === id);
  const docOut = (id: string) => {
    const d = db.documents.find((x) => x.id === id);
    return d ? { slug: d.slug, title: d.title, kind: d.kind } : null;
  };
  for (const ev of db.baseline.evidence) {
    if (!ev.source_item) continue;
    const e = entity(ev.entity_id) ?? entity(db.baseline.edges.find((x) => x.id === ev.edge_id)?.src_id);
    uses.push({
      kind: "evidence",
      at: ev.created_at,
      item: { id: ev.source_item.id, title: ev.source_item.title ?? null },
      entity: e ? { id: e.id, type: e.type, key: e.key, title: e.title, status: e.status } : null,
    });
  }
  for (const v of db.versions) {
    for (const c of v.citations) {
      if (!c.item_id) continue;
      uses.push({
        kind: "citation",
        at: v.created_at,
        item: { id: c.item_id, title: c.title ?? null },
        document: docOut(v.document_id),
        version: v.number,
        cite_key: c.cite_key,
      });
    }
  }
  for (const l of db.v2?.section_links ?? []) {
    if (!l.source_item_id) continue;
    const v = db.versions.find((x) => x.id === l.version_id);
    uses.push({
      kind: "section_link",
      at: l.created_at,
      item: { id: l.source_item_id, title: null },
      document: docOut(l.document_id),
      version: v?.number ?? null,
      section_key: l.section_key,
      section_title: v?.sections.find((x) => x.section_key === l.section_key)?.heading ?? null,
    });
  }
  return uses;
}

function ensureV2(db: Db): V2Db {
  if (!db.v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    const version = db.versions.find((v) => v.document_id === prd?.id) ?? null;
    db.v2 = seeded("v2", () => {
      const v2 = seedV2(prd?.id ?? db.tenant_id, version?.id ?? null, db.user_id);
      v2.section_links.push(...goalLinks(db));
      return v2;
    });
  }
  return db.v2;
}

/** The decision log, seeded on first use (the requests mock records a no in it, H10). */
function ensureDecisions(db: Db, ctx: DecisionsContext): DecisionsDb {
  db.decisions ??= seeded("decisions", () => {
    const log = seedDecisions(ctx);
    if (localStorage.getItem(MOCK_SCENARIO_KEY) === "large") enlargeDecisions(ctx, log, 250);
    if (localStorage.getItem(MOCK_SCENARIO_KEY) === "pricing") seedPricingDecisions(db, ctx, log);
    return log;
  });
  return db.decisions;
}

function requestsContext(db: Db, userId: string, role: Role): RequestsContext {
  const me = db.members.find((x) => x.id === userId);
  const decisionsCtx = me ? decisionsContext(db, me) : null;
  return {
    userId,
    role,
    entities: () => db.baseline.entities,
    edges: () => db.baseline.edges,
    decisions: decisionsCtx ? requestDecisions(decisionsCtx, () => ensureDecisions(db, decisionsCtx)) : undefined,
    zone: () => String(mockSettingValue("company_timezone") ?? "America/Los_Angeles"),
    goals: () => db.baseline.entities.filter((e) => e.type === "goal"),
    features: () => db.baseline.entities.filter((e) => e.type === "feature" && e.status !== "rejected"),
    people: () => db.members,
    documents: () =>
      db.documents
        .filter((d) => d.kind === "prd")
        .map((d) => {
          const latest = docVersions(db, d).at(-1);
          const sections = latest?.sections.length ?? 0;
          return {
            id: d.id,
            slug: d.slug,
            title: d.title,
            latest_version: latest?.number ?? null,
            sections,
            reviewed_sections: latest?.approved_at ? sections : 0,
          };
        }),
  };
}

/** The requests rows, seeded on first use against the baseline's confirmed goals. */
function ensureRequests(db: Db): RequestsDb {
  db.requests ??= seeded("requests", () => {
    const features = db.baseline.entities.filter((e) => e.type === "feature" && e.status !== "rejected");
    const out = seedRequests({
      ownerId: db.user_id,
      goals: db.baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed"),
      features,
    });
    if (localStorage.getItem(MOCK_SCENARIO_KEY) === WHY_NOT_SCENARIO) {
      // H10: a confirmed stop choice that affects the first feature, and the why-not requests on it.
      const feature = features[0];
      const at = "2026-10-12T09:00:00Z";
      const stop = {
        id: uuid(), type: "strategy_choice" as const, key: "s.stop-custom-exports", title: "Stop custom exports",
        body: "We stop building one-off export formats; the API covers bulk data.", attrs: { stance: "stop" }, status: "confirmed" as const,
        origin: "agent" as const, locked: false, locked_by: null, locked_at: null, confidence: null, run_id: null, created_at: at, updated_at: at,
      };
      db.baseline.entities.push(stop as (typeof db.baseline.entities)[number]);
      if (feature) {
        db.baseline.edges.push({
          id: uuid(), src_id: stop.id, dst_id: feature.id, type: "affects", attrs: {}, status: "confirmed", origin: "agent",
          locked: false, locked_by: null, locked_at: null, confidence: null, run_id: null, created_at: at, updated_at: at,
        } as (typeof db.baseline.edges)[number]);
      }
      const commenter = db.members.find((x) => x.email === "commenter@example.com")!;
      seedWhyNot(out, { ownerId: db.user_id, member: { id: commenter.id, name: displayName(commenter.email) }, featureId: feature?.id ?? null });
    }
    return out;
  });
  return db.requests;
}

/** The interviews, seeded on first use with the fixture's invited interview (`i-mock-token`). */
function ensureInterviews(db: Db): InterviewsDb {
  db.interviews ??= seeded("interviews", () => seedInterviews({ ownerId: db.user_id }));
  return db.interviews;
}

function interviewsContext(db: Db, userId: string, role: Role): InterviewsContext {
  return {
    userId,
    role,
    company: MOCK_COMPANY,
    memberEmail: (id) => db.members.find((m) => m.id === id)?.email ?? null,
    intakeTitle: (id) => ensureV2(db).intakes.find((i) => i.id === id)?.title ?? null,
    themeTitle: (id) => ensureRequests(db).themes.find((t) => t.id === id && !t.archived_at)?.title ?? null,
    fileRequest: (input) => addInterviewRequest(ensureRequests(db), input),
  };
}

function ensureBlockers(db: Db): BlockersDb {
  if (!db.blockers) {
    const v2 = ensureV2(db);
    const deposits = db.documents.find((d) => d.slug === "online-deposits");
    db.blockers = seedBlockers(
      db.documents.find((d) => d.kind === "prd")?.id ?? db.tenant_id,
      db.user_id,
      deposits && { documentId: deposits.id, v2 },
    );
  }
  return db.blockers;
}

function slugOf(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 60).replace(/-+$/, "") || "update";
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * H8: POST /v1/drafts {kind: "update"}: owners only. The update starts from its template
 * (Asks placeholder kept) for the period (default: the first of this month through today),
 * seen by owners and approvers.
 */
function startUpdate(db: Db, me: MemberRow, input: Schemas["StartDraftIn"]): Response {
  if (me.role !== "owner") return json(403, { detail: "Only an owner can start an update" });
  if (!isUpdateTemplate(input.template)) {
    return json(422, {
      detail: `template '${input.template}' is not an update template`,
      problems: [{ code: "kind_mismatch", message: "an update uses board-product or investor-update" }],
    });
  }
  const today = now().slice(0, 10);
  const period: UpdatePeriod = input.period ?? { from: `${today.slice(0, 8)}01`, to: today };
  if (!ISO_DAY.test(period.from) || !ISO_DAY.test(period.to) || period.from > period.to) {
    return json(422, { detail: "period: from and to are dates, from on or before to" });
  }
  const label = input.template === "board-product" ? "Board update" : "Investor update";
  const title = input.title?.trim() || `${label} · ${periodMonth(period)}`;
  const base = slugOf(input.slug || title);
  if (input.slug && db.documents.some((d) => d.slug === base)) return json(409, { detail: `slug '${base}' is taken` });
  let slug = base;
  for (let n = 2; db.documents.some((d) => d.slug === slug); n++) slug = `${base}-${n}`;
  const created = now();
  const doc: DocumentRow = {
    id: uuid(),
    slug,
    title,
    status: "draft",
    kind: "update",
    template: input.template,
    template_version: "1",
    theme: input.theme ?? (input.template === "board-product" ? "roadmap-board" : "one-page-brief"),
    visibility: "approvers",
    created_at: created,
    updated_at: created,
  };
  const fm = updateFrontMatter(input.template, slug, title, period);
  const v = buildVersion(doc, { number: 1, created_at: created, sections: templateSections(input.template, title), citations: [], brief: fm.brief as string[] });
  v.front_matter = fm;
  v.imported_by = "draft-picker";
  db.documents.push(doc);
  db.versions.push(v);
  return json(201, {
    document_id: doc.id,
    slug,
    title,
    kind: "update",
    template: input.template,
    template_version: 1,
    theme: doc.theme ?? null,
    version: 1,
  } satisfies Schemas["StartDraftOut"]);
}

/** H9: a pricing memo from its template, for owners and approvers; the question and evidence window in its front matter. */
function startPricing(db: Db, me: MemberRow, input: Schemas["StartDraftIn"]): Response {
  if (!atLeast(me.role, "approver")) return json(403, { detail: "Only an approver can start a pricing memo" });
  const question = input.question?.trim() ?? "";
  if (!question || question.length > 300) return json(422, { detail: "Say the pricing question in one sentence" });
  const today = todayIn(String(mockSettingValue("company_timezone") ?? "America/Los_Angeles"));
  const window: EvidenceWindow = input.period ?? { from: addMonths(today, -6), to: today };
  if (!ISO_DAY.test(window.from) || !ISO_DAY.test(window.to) || window.from > window.to) return json(422, { detail: "evidence_window: from and to are dates, from on or before to" });
  const title = input.title?.trim() || "Pricing memo";
  const base = slugOf(input.slug || title);
  let slug = base;
  for (let n = 2; db.documents.some((d) => d.slug === slug); n++) slug = `${base}-${n}`;
  const created = now();
  const doc: DocumentRow = {
    id: uuid(), slug, title, status: "draft", kind: "pricing", template: PRICING_TEMPLATE, template_version: "1",
    theme: input.theme ?? "one-page-brief", visibility: "approvers", created_at: created, updated_at: created,
  };
  const v = buildVersion(doc, { number: 1, created_at: created, sections: pricingTemplateSections(title), citations: [], brief: ["question", "recommendation", "options"] });
  v.front_matter = pricingFrontMatter(slug, title, question, window);
  v.imported_by = "draft-picker";
  db.documents.push(doc);
  db.versions.push(v);
  return json(201, { document_id: doc.id, slug, title, kind: "pricing", template: PRICING_TEMPLATE, template_version: 1, theme: doc.theme ?? null, version: 1 } satisfies Schemas["StartDraftOut"]);
}

async function route(db: Db, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = url.searchParams;
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;

  if (p[0] === "healthz") return json(200, { status: "ok", database: "mock" });
  if (p[0] !== "v1") return notFound("Route");

  if (p[1] === "auth" && p[2] === "login" && m === "POST") {
    const { email, password } = await body<Schemas["LoginRequest"]>();
    const member = db.members.find((x) => x.email === email.trim().toLowerCase());
    db.account ??= seedAccount(db.members, uuid);
    if (!member || member.status === "disabled" || !passwordOk(db.account, member.email, password, MOCK_LOGIN.password)) {
      return json(401, { detail: "Invalid credentials" });
    }
    setSession(db, member.email);
    member.last_sign_in_at = now();
    return json(200, meOut(db, withMockRole(member)));
  }
  if (p[1] === "auth" && p[2] === "logout" && m === "POST") {
    setSession(db, null);
    return json(204, undefined);
  }
  // C3: the customer page's routes carry no member credential, only the link's token and cookie.
  if (p[1] === "public" && p[2] === "interviews") {
    const out = await routePublicInterviews(ensureInterviews(db), interviewsContext(db, db.user_id, "viewer"), req, p);
    if (out) return out;
  }
  // A5: where a Google sign-in without membership stands (the access-* scenarios); /v1/me is then 401.
  const access = ACCESS_SCENARIOS[localStorage.getItem(MOCK_SCENARIO_KEY) ?? ""];
  if (p[1] === "auth" && p[2] === "access") {
    const signedIn = db.members.find((x) => x.email === sessionOf(db) && x.status !== "disabled");
    const state = access ?? (signedIn ? "member" : "no_google_sign_in");
    const out: Schemas["AccessStateOut"] = {
      state,
      email: access ? ACCESS_EMAIL : (signedIn?.email ?? null),
      company: "Acme",
      requested_at: state === "pending" ? "2026-10-21T16:05:00Z" : null,
      note: (db.access_note ??= null),
      invite_expired_at: state === "invite_expired" ? "2026-10-30T12:00:00Z" : null,
    };
    if (p[3] === "note" && m === "POST") {
      if (state !== "pending") return json(409, { detail: "There is no request waiting for a note" });
      const { note } = await body<Schemas["AccessNote"]>();
      if ((note ?? "").length > 500) return json(422, { detail: "A note is at most 500 characters" });
      db.access_note = out.note = note?.trim() || null;
      return json(200, out);
    }
    if (!p[3] && m === "GET") return json(200, out);
  }
  if (access) return json(401, { detail: "Not authenticated" });
  const member = db.members.find((x) => x.email === sessionOf(db));
  if (!member || member.status === "disabled") return json(401, { detail: "Not authenticated" });
  const me = withMockRole(member);
  // H8: an "approvers" document (an update) is absent for commenters and viewers, on every
  // documents path (its versions, markdown, exports, deck, feedback, comments, scope, ...).
  if (p[1] === "documents" && p[2]) {
    const hidden = findDocument(db, p[2]);
    if (hidden && !canSee(me.role, hidden.visibility)) return notFound("Document");
  }
  // H9 Pricing input: pricing memos, Decide, win and loss records, the pricing owner.
  if (p[1] === "pricing-memos" && atLeast(me.role, "approver")) {
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    ensureDecisions(db, decisionsContext(db, me));
  }
  const priced = await routePricing(db, me, req, p, q);
  if (priced) return priced;
  // #482: delete, restore, Settings › Trash and Regenerate (./trash.ts).
  const trashOut = await routeTrash(
    {
      db: (db.trash ??= emptyTrash()),
      documents: db.documents,
      versions: db.versions,
      runs: () => (db.runs ??= seeded("runs", () => seedRuns(runsContext(db)))).runs,
      intakes: () => ensureV2(db).intakes,
      specRequests: () => (db.specs ??= seedSpecs()).specs.map((s) => ({ source_document_id: s.request.source_document_id, document_slug: s.document_slug })),
      me,
      uuid,
      now,
    },
    req,
    p,
    q,
  );
  if (trashOut) return trashOut;
  // v2 review routes (./review-v2.ts) check roles themselves.
  if (!db.review_v2) {
    const prd = db.documents.find((d) => d.kind === "prd");
    db.review_v2 = seedReviewV2(prd, prd ? docVersions(db, prd).pop() : undefined, db.user_id, hash);
    // The "plan-decider" scenario (#346): the approver is usage-alerts-roadmap's designated decider.
    const roadmapDoc = db.documents.find((d) => d.slug === ALERTS_ROADMAP_SLUG);
    const decider = db.members.find((x) => x.email === "approver@example.com");
    if (localStorage.getItem(MOCK_SCENARIO_KEY) === "plan-decider" && roadmapDoc && decider) {
      db.review_v2.policies.push({
        document_id: roadmapDoc.id, decider_id: decider.id, mandatory_reviewer_ids: [], required_section_keys: [],
        section_approval: "none", rereview_on_change: true, source: "document", lock_version: 1,
      });
    }
  }
  const reviewV2 = await routeReviewV2(reviewV2Context(db, me.id, me.role), req, p, q);
  if (reviewV2) return reviewV2;
  if (p[1] === "me" && p[2] === "capabilities" && m === "GET") {
    const caps = await capabilitiesOut(me.role, !!me.engineering_lead, engineeringLeads(db).length > 0);
    for (const op of (localStorage.getItem(MOCK_DENY_KEY) ?? "").split(",")) if (op.trim()) caps.operations[op.trim()] = false;
    return json(200, caps);
  }
  if (p[1] === "me" && p[2] === "preferences") {
    db.preferences ??= {};
    const mine = (db.preferences[me.email] ??= { document_view: "brief", setup_hidden: false });
    if (m === "PATCH") {
      const patch = await body<Schemas["PreferencesUpdate"]>();
      if (patch.document_view && !["brief", "full"].includes(patch.document_view)) return json(422, { detail: "document_view" });
      if (patch.document_view) mine.document_view = patch.document_view;
      if (typeof patch.setup_hidden === "boolean") mine.setup_hidden = patch.setup_hidden;
    }
    mine.setup_hidden ??= false; // saved before A1
    return json(200, mine);
  }
  if (p[1] === "setup" && !p[2] && m === "GET") return json(200, setupOut(db, me));
  const accountOut = await accountRoute(
    {
      db: (db.account ??= seedAccount(db.members, uuid)),
      members: db.members,
      me,
      defaultPassword: MOCK_LOGIN.password,
      uuid,
      now,
      // Every tab's sign-in ends (sign out everywhere, a changed password).
      endSession: () => {
        setSession(db, null);
        db.tab_sessions = {};
      },
      readOnly: localStorage.getItem(MOCK_SCENARIO_KEY) === "read-only-credential",
    },
    req,
    p,
    q,
  );
  if (accountOut) return accountOut;
  if (p[1] === "me") return json(200, meOut(db, me));
  if (p[1] === "discussions" || p[1] === "discussion-changes") {
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const discussionsCtx: DiscussionsContext = {
      db: (db.discussions ??= emptyDiscussions()),
      members: db.members,
      me: { id: me.id, role: me.role },
      resolve: (kind, subject) => discussionSubject(db, kind, subject),
      uuid,
      now,
      refusal: () => poolRefusal(localStorage.getItem(MOCK_SCENARIO_KEY)),
      // A streaming reply writes after its response: in turn with every other request.
      persist: (change) => {
        const next = queue.then(() => {
          const saved = load();
          change((saved.discussions ??= emptyDiscussions()));
          save(saved);
        });
        queue = next.catch(() => undefined);
        return next;
      },
      current: () => load().discussions ?? emptyDiscussions(),
      // B6: the scripted Oracle of a goals interview.
      replyScript: (d, asked) => goalInterviewReply(db.baseline, d, asked.body, (id) => activeMember(db, id)),
      // G8: the link to a Slack thread needs Oracle's Slack install (./slack.ts).
      slack: (d, r) => discussionSlackRoute(d, { me, integration: ensureReports(db, db.user_id).integration }, r),
      documentText: (d) => discussionDocument(db, d),
      // G3 Record: F3's date rights and its schedule-basis route, as the API's record() uses them.
      dateRights: () => {
        const leads = engineeringLeads(db);
        if (me.role === "owner" || (leads.includes(me.id) && atLeast(me.role, "commenter"))) return "verify";
        return atLeast(me.role, "approver") ? (leads.length ? "propose" : "verify") : null;
      },
      recordBasis: async (b) => {
        const ctx = roadmapContext(db, me);
        db.roadmap ??= seedRoadmap(ctx, localStorage.getItem(MOCK_SCENARIO_KEY));
        const post = new Request("http://mock/v1/schedule-bases", { method: "POST", body: JSON.stringify(b) });
        return (await routeRoadmap(ctx, db.roadmap, post, ["v1", "schedule-bases"], new URLSearchParams()))!;
      },
    };
    const res = await routeDiscussions(discussionsCtx, req, p, q);
    if (res) return res;
  }
  if (p[1] === "members" || p[1] === "invites" || p[1] === "access-requests") return membersRoute(db, req, p, me);
  // A5: who becomes a member on a Google sign-in (Settings › Members › Sign-in), owners only.
  if (p[1] === "sign-in-rules" && !p[2] && m === "GET") {
    if (!atLeast(me.role, "owner")) return forbidden("owner");
    const stored = mockSettingValue("company_email_domains");
    const set = (Array.isArray(stored) ? stored : []).map(String).filter((d) => !SIGN_IN_DOMAINS.includes(d));
    const rules: Schemas["SignInRulesOut"] = {
      google_sign_in: true,
      new_sign_ins_off: false,
      domains: [...SIGN_IN_DOMAINS.map((domain) => ({ domain, from: "deployment" as const })), ...set.map((domain) => ({ domain, from: "settings" as const }))],
      without_invite: String(mockSettingValue("sign_in_without_invite") ?? "request") as Schemas["SignInRulesOut"]["without_invite"],
      default_role: String(mockSettingValue("iap_default_role") ?? "commenter") as Role,
    };
    return json(200, rules);
  }
  // Tech briefs (./engineering.ts): every member reads.
  const briefs = await routeEngineering(req, p, q, {
    documents: db.documents,
    maps: () => (db.code_maps ??= []),
    me: { id: me.id, email: me.email, canWrite: atLeast(me.role, "commenter") },
    now,
    uuid,
  });
  if (briefs) return briefs;
  // #481: the staleness actions on a spec's version are the specs mock's (./specs.ts).
  if (p[1] === "trace" && p[2] === "staleness" && p[3] === "actions" && m === "POST") {
    const acted = await specStalenessAction({ db: (db.specs ??= seedSpecs()), userId: me.id, role: me.role, uuid, now }, req);
    if (acted) return acted;
  }
  // Trace, impact, staleness and evidence-inspector routes (./trace.ts), on the v2 rows.
  if (["documents", "section-links", "baseline", "trace"].includes(p[1])) {
    const traced = await routeTrace(
      {
        v2: ensureV2(db),
        documents: db.documents,
        versions: db.versions,
        entities: db.baseline.entities,
        edges: db.baseline.edges,
        userId: me.id,
        role: me.role,
        now,
        uuid,
      },
      req,
      p,
      q,
    );
    if (traced) return traced;
  }
  // B2: what a run wrote to the baseline (viewer+), its rows read under its shared draft.
  if (p[1] === "baseline" && p[2] === "from-run" && p[3] && req.method === "GET") {
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const found = fromRunCheckpoint({ ...runsContext(db), db: db.runs }, p[3]);
    if (!found) return json(404, { detail: `run ${p[3]} not found` });
    return json(200, { ...found, ...fromRun(db.baseline, p[3], found.actions), checkpoint: found.checkpoint });
  }
  // B6 Goals interview: its routes write discussions and proposals, so they come first.
  if (p[1] === "baseline") {
    const goalCtx: GoalInterviewContext = {
      baseline: db.baseline,
      discussions: () => (db.discussions ??= emptyDiscussions()),
      members: db.members,
      me: { id: me.id, role: me.role },
      isMember: (id) => activeMember(db, id),
      uuid,
      now,
    };
    const res = await routeGoalInterview(goalCtx, req, p);
    if (res) return res;
    if (p[2] === "proposals" && p[3] && p[4] === "accept" && req.method === "POST") {
      const accepted = await routeBaselineFor(db, me, req, p, q);
      if (accepted.ok) afterAccept(goalCtx, p[3]);
      return accepted;
    }
  }
  // The baseline mock checks roles itself (commenters propose, approvers decide).
  if (p[1] === "baseline") return routeBaselineFor(db, me, req, p, q);
  // Sources and connections belong to each user: every role manages their own.
  if (["sources", "source-items", "snapshots", "search"].includes(p[1])) {
    return routeSources(req, p, q, {
      scenario: localStorage.getItem(MOCK_SCENARIO_KEY),
      me: { email: me.email, role: me.role },
      members: db.members.map((x) => ({ id: x.id, email: x.email, role: x.role, disabled: x.status === "disabled" })),
      uses: () => itemUses(db),
    });
  }
  const fireflies = await routeFirefliesBrowse(p, q);
  if (fireflies) return fireflies;
  // How far Oracle goes on its own (H11): everyone reads, owners change; its Inbox rows.
  db.autonomy ??= emptyAutonomy();
  const autonomy = await routeAutonomy(db.autonomy, req, p, me);
  if (autonomy) return autonomy;
  // Company settings are the owner's, as in the API (tenant_settings_api.py).
  if (p[1] === "settings" && !atLeast(me.role, "owner")) return forbidden("owner");
  const browse = sourceBrowseRoute(req, p, q);
  if (browse) return browse;
  const connections = await connectionsRoute(req, p);
  if (connections) return connections;
  // The Claude account pool checks roles itself: every member reads, owners change.
  const pool = await claudeAccountsRoute(req, p, q, me.role, localStorage.getItem(MOCK_SCENARIO_KEY));
  if (pool) return pool;
  // G8: the Slack install's status (every member) and its channels (commenters and up).
  const slack = slackRoute(ensureReports(db, db.user_id).integration, me, req, p);
  if (slack) return slack;
  // Alignment reports and the company Slack install check roles themselves (./reports.ts).
  // H5: metrics, their variances and the analytics connection check roles themselves (./metrics.ts).
  const metricsOut = await routeMetrics(metricsContext(db, me), ensureMetrics(db, me), req, p, q);
  if (metricsOut) return metricsOut;
  const reports = await reportsRoute(db, db.user_id, me, req, p, q);
  if (reports) return reports;
  // Built-in model jobs check roles themselves (approvers decide, owners set them up).
  db.llm ??= seeded("llm", () => seedLlm(llmContext(db, db.user_id, "owner")));
  const llm = llmContext(db, me.id, me.role);
  // C7: a scope_enhance job lives with the run's scope (./scope.ts).
  const scopeJob = scopeJobRoute(db.runs, p, now);
  if (scopeJob) return scopeJob;
  const jobs = await llmJobsRoute(llm, req, p, q);
  if (jobs) return jobs;
  // G4 One staging list (./staging.ts) checks roles itself.
  if (p[1] === "staging" || p[1] === "next-draft-changes") {
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const runs = db.runs;
    const staged = await routeStaging(
      {
        llm,
        role: me.role,
        checkpoint: (id) => runs.runs.flatMap((r) => r.checkpoints).find((c) => c.id === id) ?? null,
        draft: (id) => runs.drafts?.[id] ?? null,
      },
      req,
      p,
      q,
    );
    if (staged) return staged;
  }
  // PRD quality and readiness, outcomes and learnings (./quality.ts) check roles themselves.
  const v2db = ensureV2(db);
  db.quality ??= seedQuality();
  const qualityCtx: QualityContext = {
    db: db.quality,
    v2: v2db,
    userId: me.id,
    role: me.role,
    findVersion: (ref, n) => {
      const doc = findDocument(db, ref);
      const v = doc && findVersion(db, doc, n);
      return doc && v ? { documentId: doc.id, slug: doc.slug, versionId: v.id } : null;
    },
    blockerGate: (documentId) => documentGate(ensureBlockers(db), documentId),
  };
  const quality = await routeQuality(qualityCtx, req, p, q);
  if (quality) return quality;
  // Specs, flows and wireframes (./specs.ts) check roles themselves.
  if (p[1] === "spec-requests" || p[1] === "design-artifacts") {
    db.specs ??= seedSpecs();
    const specs = await routeSpecs({ db: db.specs, userId: me.id, role: me.role, uuid, now }, req, p, q);
    if (specs) return specs;
  }
  // Modules and compositions check roles themselves (viewers may ask for a recommendation).
  if (!db.modules) {
    const prd = db.documents.find((d) => d.kind === "prd");
    db.modules = seedModules(prd?.id ?? null, db.user_id);
  }
  const modules = await routeModules(
    db.modules,
    {
      userId: me.id,
      role: me.role,
      document: (ref) => {
        const doc = findDocument(db, ref);
        return doc && doc.kind === "prd" ? { id: doc.id, slug: doc.slug, template: doc.template ?? null } : null;
      },
      approvedVersion: (documentId, n) =>
        db.versions.find((v) => v.document_id === documentId && v.number === n && v.approved_at)?.id ?? null,
    },
    req,
    p,
    q,
  );
  if (modules) return modules;
  // Team interviews (C3 lane 2): the member's interview on an intake and its turns, which
  // record answers through the intake mock's answer path.
  if ((p[1] === "intakes" && p[3] === "interview") || (p[1] === "interviews" && p[3] === "turns")) {
    const recordAnswer = async (id: string, body: string) => {
      const answer = new Request(new URL(`/v1/questions/${id}/answers`, req.url), {
        method: "POST",
        body: JSON.stringify({ kind: "answer", body, knowledge_state: "user_decision", evidence_ids: [] }),
      });
      const ctx = { userId: me.id, role: me.role, people: db.members, createRun: async () => notFound("Route") };
      return (await routeIntake(v2db, ctx, answer, ["v1", "questions", id, "answers"], new URLSearchParams())) ?? notFound("Route");
    };
    const nextQuestion = (intakeId: string, after: string) =>
      v2db.questions
        .filter((x) => x.intake_id === intakeId && x.asked_to === me.id && (x.status === "asked" || x.status === "delegated") && x.id !== after)
        .sort((a, b) => (a.batch ?? 0) - (b.batch ?? 0) || a.created_at.localeCompare(b.created_at))[0]?.id ?? null;
    const team = await routeTeamInterviews(
      ensureInterviews(db),
      {
        ...interviewsContext(db, me.id, me.role),
        intakeExists: (id) => v2db.intakes.some((i) => i.id === id),
        question: (id) => v2db.questions.find((x) => x.id === id) ?? null,
        nextQuestion,
        recordAnswer,
      },
      req,
      p,
    );
    if (team) return team;
  }
  // Intake, gaps, questions and answers (CR-03) check roles themselves: commenters
  // answer and propose, approvers decide, owners accept a critical risk.
  // Questions to people (C2): Ask a teammate, reassign or withdraw, the Inbox's questions
  // and the member directory, with the API's rules.
  if (["intakes", "gaps", "questions", "intake-proposals", "people"].includes(p[1]) || (p[1] === "inbox" && p[2] === "questions")) {
    const createRun = (input: Schemas["RunCreate"]) => {
      db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
      const run = new Request(new URL("/v1/runs", req.url), { method: "POST", body: JSON.stringify(input) });
      return routeRuns({ ...runsContext(db), db: db.runs }, run, ["v1", "runs"]).then((r) => r ?? notFound("Route"));
    };
    const subjects: SubjectLookup = {
      document: (id) => {
        const doc = db.documents.find((d) => d.id === id);
        const latest = doc ? docVersions(db, doc).pop() : undefined;
        if (!doc || !latest) return null;
        return {
          slug: doc.slug,
          title: doc.title,
          latest: latest.number,
          heading: (key) => latest.sections.find((x) => x.section_key === key)?.heading ?? null,
        };
      },
      entity: (id) => db.baseline.entities.find((e) => e.id === id)?.title ?? null,
      checkpoint: (id) => {
        for (const run of db.runs?.runs ?? []) {
          const cp = run.checkpoints.find((c) => c.id === id);
          if (cp) return { run_id: run.id, kind: cp.kind };
        }
        return null;
      },
    };
    const updateRun = async (id: string, body: Schemas["RunPatch"]) => {
      const run = db.runs?.runs.find((r) => r.id === id);
      if (!run || run.status !== "draft") return null;
      const patch = new Request(new URL(`/v1/runs/${id}`, req.url), { method: "PATCH", body: JSON.stringify(body) });
      return routeRuns({ ...runsContext(db), db: db.runs! }, patch, ["v1", "runs", id]).then((r) => r ?? notFound("Route"));
    };
    const confirmedGoals = () => new Map(db.baseline.entities.filter((e) => e.type === "goal" && e.status === "confirmed").map((e) => [e.id, e.title]));
    const lockedSections = (ref: string) => {
      const doc = db.documents.find((d) => d.id === ref || d.slug === ref);
      const latest = doc && db.versions.filter((v) => v.document_id === doc.id).sort((a, b) => b.number - a.number)[0];
      if (!latest) return [];
      return latest.sections.map((s) => s.section_key).filter((k) => {
        const r = latestReview(db, latest.id, k);
        return r?.verdict === "approved" && !r.lapsed_at;
      });
    };
    // C5 late answers: a whole-draft item on the PRD's latest version, as late_answers._raise.
    const raiseFeedback = (ref: string, input: { summary: string; author_id: string | null; intake_question_id: string; intake_answer_id: string }) => {
      const doc = db.documents.find((d) => d.id === ref || d.slug === ref);
      const latest = doc ? docVersions(db, doc).pop() : undefined;
      if (!doc || !latest) return null;
      const at = now();
      // An item kept with its quote withheld reads in full again.
      const kept = db.feedback.find((f) => f.intake_answer_id === input.intake_answer_id);
      if (kept) {
        Object.assign(kept, { summary: input.summary, updated_at: at });
        touch(db, kept.document_id);
        return { slug: doc.slug, version: kept.raised_on_version };
      }
      db.feedback.push({
        id: uuid(), document_id: doc.id, raised_on_version: latest.number, kind: "general", comment_id: null, section_review_id: null,
        section_key: null, summary: input.summary, author_id: input.author_id, anchor: null, verdict: null, status: "open",
        addressed_in_version: null, resolution_note: null, severity: null, created_at: at, updated_at: at,
        intake_id: v2db.questions.find((x) => x.id === input.intake_question_id)?.intake_id ?? null,
        intake_question_id: input.intake_question_id, intake_answer_id: input.intake_answer_id,
      });
      touch(db, doc.id);
      onFeedback(llm, doc.id, latest.number);
      return { slug: doc.slug, version: latest.number };
    };
    // As late_answers.on_sharing: an item nobody acted on goes, with its suggestions (the
    // API's cascade); one someone triaged, staged or decided a suggestion on stays, its quote withheld.
    const withdrawFeedback = (answerIds: string[]) => {
      const kept: string[] = [];
      for (let i = db.feedback.length - 1; i >= 0; i--) {
        const f = db.feedback[i];
        if (!f.intake_answer_id || !answerIds.includes(f.intake_answer_id)) continue;
        const decided = db.llm?.suggestions.some((x) => x.feedback_item_id === f.id && x.status !== "open" && x.status !== "superseded");
        if (f.status !== "open" || f.resolution_note || f.staged_for_agents_at || decided) {
          Object.assign(f, { summary: LATE_ANSWER_WITHHELD, updated_at: now() });
          kept.push(f.intake_answer_id);
        } else {
          db.feedback.splice(i, 1);
          if (db.llm) db.llm.suggestions = db.llm.suggestions.filter((x) => x.feedback_item_id !== f.id);
        }
        touch(db, f.document_id);
      }
      return kept;
    };
    const intake = await routeIntake(
      v2db,
      { userId: me.id, role: me.role, createRun, updateRun, people: db.members, subjects, confirmedGoals, lockedSections, raiseFeedback, withdrawFeedback },
      req,
      p,
      q,
    );
    if (intake) return intake;
  }
  // Customer interviews (C3) check roles themselves: commenters create, the creator or an approver manages.
  if (p[1] === "interviews") {
    const interviews = await routeInterviews(ensureInterviews(db), interviewsContext(db, me.id, me.role), req, p, q);
    if (interviews) return interviews;
  }
  // Requests and their themes (C1) check roles themselves: commenters add, approvers decide.
  if (["requests", "request-themes", "request-candidates", "request-replies"].includes(p[1])) {
    const requests = await routeRequests(ensureRequests(db), requestsContext(db, me.id, me.role), req, p, q);
    if (requests) return requests;
  }
  // Launches and changelog (H6) check roles themselves: a task's owner edits their task.
  const launches = await routeLaunches(launchesContext(db, me), ensureLaunches(db), req, p, q);
  if (launches) return launches;
  // The API's role checks: viewers read, commenters comment, approvers decide. A checkpoint's
  // shared draft (D8, ./runs.ts) checks its own: commenters suggest, approvers stage. So does
  // the decision log (./decisions.ts): commenters propose, edit and withdraw.
  // A decision checks who decides itself (A3: an engineering lead below the approver role).
  // So do F3's schedule bases (./roadmap.ts date rights): a named engineering lead below the
  // approver role records, verifies, rejects and withdraws them.
  const draftWrite = p[1] === "runs" && p[3] === "checkpoints" && (p[5] === "actions" || p[5] === "note" || p[5] === "decide");
  const need: Role | null =
    m === "GET" || draftWrite || p[1] === "decisions" || p[1] === "schedule-bases"
      ? null
      : p[1] === "comments" || ((p[5] === "comments" || p[5] === "feedback") && m === "POST") ||
          // As the API: commenters propose a blocker's solution options.
          (p[1] === "blockers" && p[3] === "options" && m === "POST")
        ? "commenter"
        : "approver";
  if (need && !atLeast(me.role, need)) return forbidden(need);

  if (p[1] === "comments" && p[2]) {
    const c = db.comments.find((x) => x.id === p[2]);
    if (!c) return notFound("Comment");
    if (p[3] === "replies" && m === "POST") {
      const { body: text } = await body<Schemas["ReplyCreate"]>();
      const r: CommentRow = {
        id: uuid(),
        version_id: c.version_id,
        section_key: c.section_key,
        anchor: null,
        body: text,
        author_id: me.id,
        parent_id: c.id,
        resolved_at: null,
        created_at: now(),
        feedback_item_id: null,
      };
      db.comments.push(r);
      return json(201, commentOut(db, r));
    }
    if (m === "PATCH") {
      if (c.author_id !== me.id && !atLeast(me.role, "approver")) {
        return json(403, { detail: "Only the author or an approver can change this comment" });
      }
      const patch = await body<Schemas["CommentPatch"]>();
      if (patch.resolved != null) c.resolved_at = patch.resolved ? now() : null;
      if (patch.body != null) c.body = patch.body;
      return json(200, commentOut(db, c));
    }
  }

  if (p[1] === "feedback" && p[2] && m === "PATCH") {
    const f = db.feedback.find((x) => x.id === p[2]);
    if (!f) return notFound("Feedback item");
    const patch = await body<Schemas["FeedbackPatch"]>();
    // As the API: reopening clears the version it was addressed in, unless one is given.
    if (patch.status === "open" && !("addressed_in_version" in patch)) patch.addressed_in_version = null;
    Object.assign(f, patch, { updated_at: now() });
    return json(200, f);
  }

  // Product Oracle v2 read routes; viewers read (lanes add writes in ./v2.ts).
  const v2Db = ensureV2(db);
  // Blocker strategy routes (CR-04): writes on the v2 option, experiment and event rows.
  const blockerContext = { userId: me.id, role: me.role, v2: v2Db, documents: db.documents, baseline: db.baseline };
  const blockers = await routeBlockers(blockerContext, ensureBlockers(db), req, p, q);
  if (blockers) return blockers;
  const v2 = routeV2(v2Db, req, p, q, me.id);
  if (v2) return v2;

  // Roadmap alignment and product tracks (CR-11).
  const roadmapCtx = roadmapContext(db, me);
  // E1: a PRD draft's roadmap items and the PRD's "Derive for each new draft" switch.
  const draftRes = await routeDraftRoadmap(draftCtx(db), draftDb(db), req, p, q);
  if (draftRes) return draftRes;
  db.roadmap ??= seedRoadmap(roadmapCtx, localStorage.getItem(MOCK_SCENARIO_KEY));
  db.plan_edits ??= emptyPlanEdits();
  const editsRes = await routeChangeSets(planEditsContext(db, me), db.plan_edits, req, p, q);
  if (editsRes) return editsRes;
  const roadmapRes = await routeRoadmap(roadmapCtx, db.roadmap, req, p, q);
  if (roadmapRes) return roadmapRes;
  // The Plan (F1): one read of the PRDs in play and the roadmap rows.
  const goals = db.baseline.entities.filter((e) => e.type === "goal").map((e) => ({ id: e.id, key: e.key }));
  const planRes = routePlan({ ...roadmapCtx, goals, edits: db.plan_edits }, db.roadmap, req, p, q);
  if (planRes) return planRes;
  if (p[1] === "tracks" && p[3] === "roadmap-run" && m === "POST") {
    if (!atLeast(me.role, "approver")) return json(403, { detail: "Requires the approver role" });
    const run = trackRunBody(roadmapCtx, db.roadmap, p[2]);
    if (!run) return notFound("Track");
    db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
    const forwarded = new Request(new URL("/v1/runs", req.url), { method: "POST", body: JSON.stringify(run), headers: { "Content-Type": "application/json" } });
    return (await routeRuns({ ...runsContext(db), db: db.runs }, forwarded, ["v1", "runs"]))!;
  }

  // H8: an update starts from its template with its period (owners only); other kinds as before.
  if (p[1] === "drafts" && p.length === 2 && m === "POST") {
    const input = (await req.clone().json()) as Schemas["StartDraftIn"] | null;
    if (input?.kind === "update") return startUpdate(db, me, input);
    if (input?.kind === "pricing") return startPricing(db, me, input);
  }
  if (p[1] === "priorities" && p[2] === "calibration" && p.length === 3 && m === "GET") return json(200, trackRecord(db));
  const handled = await laneF(db, req, p, m, me.role);
  // E1: a draft started from the template's empty skeleton has nothing to derive yet.
  if (handled?.status === 201 && p[1] === "drafts" && p.length === 2 && m === "POST") {
    const started = (await handled.clone().json()) as { document_id?: string; version?: number };
    const v = db.versions.find((x) => x.document_id === started.document_id && x.number === (started.version ?? 1));
    if (v && started.document_id) queueDraft(db, started.document_id, v, "skeleton");
  }
  if (handled) return handled;

  const followUp = followUpsRoute(db, req, p, me);
  if (followUp) return followUp;

  db.runs ??= seeded("runs", () => seedRuns(runsContext(db)));
  // The decision log (H1): judgement calls, and a record of every run stop decided.
  const decisionsCtx = decisionsContext(db, me);
  ensureDecisions(db, decisionsCtx);
  const decided = await routeDecisions(decisionsCtx, db.decisions!, req, p, q);
  if (decided) return decided;
  // Rituals (H2): the built-ins in every company; occurrences in the "rituals" scenario only.
  const ritualsCtx = ritualsContext(db, me);
  // Market (H7): alternatives, the change log and positioning; seeded in the "market" scenario only.
  const market = await routeMarket(
    { me: { id: me.id, email: me.email, name: me.name ?? null, role: me.role }, uuid, companyTimezone: ritualsCtx.companyTimezone },
    ensureMarket(db),
    req,
    p,
    q,
  );
  if (market) return market;
  const ritual = await routeRituals(ritualsCtx, ensureRituals(db, me), req, p, q);
  if (ritual) return ritual;
  const seenBefore = db.inbox_seen?.[me.id] ?? null;
  // E1: the ticker moves each PRD draft's derivation one step (queued -> running -> ready).
  if (p[1] === "internal" && p[2] === "tick" && m === "POST") tickDraftRoadmaps(draftCtx(db), draftDb(db));
  const runs = await routeRuns({ ...runsContext(db), db: db.runs }, req, p);
  // C4: an intake's draft run that starts converts its brief (the API's drafting.on_start).
  if (runs?.ok && req.method === "POST" && p[1] === "runs" && p[3] === "start" && p.length === 4) startedIntakeRun(ensureV2(db), p[2]);
  if (runs && p[1] === "inbox") {
    tick(llm);
    const withStates = withInboxStates(db, llm, me, await runs.json(), q.get("mark_seen") === "true");
    // Decision rows: proposals I decide and reviews due count; informed and done do not.
    const decisions = decisionInbox(decisionsCtx, db.decisions!, seenBefore);
    const counted = decisions.filter((d) => d.counts).length;
    const inbox = { ...withStates, decisions, total: withStates.total + counted, needs_me: (withStates.needs_me ?? 0) + counted };
    // Launch rows (H6): Ready to launch, Set tier and Notes to send count; Shipped is shown only.
    const launchRows = launchInboxRows(launchesContext(db, me), ensureLaunches(db));
    inbox.launches = launchRows;
    inbox.total += launchRows.filter((r) => r.counted).length;
    // Ritual rows (H2): Pre-read ready until opened, Record notes after the end, failed to prepare.
    const ritualRows = ritualInbox(ritualsCtx, ensureRituals(db, me));
    const ritualCounted = ritualRows.filter((r) => r.counts).length;
    inbox.rituals = ritualRows;
    inbox.total += ritualCounted;
    inbox.needs_me = (inbox.needs_me ?? 0) + ritualCounted;
    // Outcome rows (H3): Add predictions and Outcome check due count; Oracle recorded is shown.
    const outcomeRows = outcomeInboxRows(db.quality, me.id, "Checkout roadmap");
    inbox.outcomes = outcomeRows;
    inbox.total += outcomeRows.filter((r) => r.counts).length;
    // Request rows (H10): Replies to send and Asked again count; Answer to your request is shown.
    const requestRows = requestInboxRows(db.requests, requestsContext(db, me.id, me.role));
    inbox.requests = requestRows;
    inbox.total += requestRows.filter((r) => r.counts).length;
    inbox.needs_me = (inbox.needs_me ?? 0) + requestRows.filter((r) => r.counts).length;
    // Metric rows (H5): Explain a variance, Find out and Metric not read for a day; all count.
    const metricRows = metricInbox(metricsContext(db, me), ensureMetrics(db, me));
    const metricCounted = metricRows.filter((r) => r.counts).length;
    inbox.metrics = metricRows;
    inbox.total += metricCounted;
    inbox.needs_me = (inbox.needs_me ?? 0) + metricCounted;
    // Owners also see the provider revokes a removed member's disable could not make.
    db.revoke_failures ??= [];
    const failures = atLeast(me.role, "owner")
      ? db.revoke_failures.filter((r) => !r.dismissed).map((r) => ({ ...r, dismissed: undefined }))
      : [];
    const accessFailures = atLeast(me.role, "owner") ? (db.access_failures ??= []) : [];
    // Owners also get the weekly alignment reports and the posts Slack refused (F6), and
    // one strategy drift row however many findings are open (H4). Those Oracle told: what
    // it did on its own (H11); unopened rows count.
    const reported = inboxReports(ensureReports(db, db.user_id), me);
    const strategy = inboxStrategy(db.strategy, me.role);
    const did = inboxActions((db.autonomy ??= emptyAutonomy()), me.id);
    const open = did.filter((a) => a.counts).length;
    // F3: proposed date bases, for the engineering leads (and owners while none is named).
    const leads = engineeringLeads(db);
    const verifiesDates = (leads.includes(me.id) && atLeast(me.role, "commenter")) || (me.role === "owner" && !leads.length);
    const dates =
      verifiesDates && db.roadmap
        ? db.roadmap.bases
            .filter((b) => b.status === "proposed")
            .flatMap((b) => {
              const prd = db.documents.find((d) => d.id === b.prd_document_id);
              return prd ? [{ ...b, prd: { id: prd.id, slug: prd.slug, title: prd.title } }] : [];
            })
        : [];
    // F2: the track group (the track's owner, else every owner); its new and open alerts count.
    const tracked = inboxTracks(roadmapCtx, db.roadmap, seenBefore);
    // G6: invitations, mentions and changes proposed in discussions; new and open ones count.
    const discussions = discussionInboxRows(db.discussions ?? emptyDiscussions(), db.members, me, seenBefore);
    const discussing = discussions.filter((r) => r.state !== "done").length;
    // A5: pending access requests, for owners and approvers; each counts.
    const accessRequestRows = inboxAccessRequests(db, me);
    return json(200, {
      ...inbox,
      access_requests: accessRequestRows,
      tracks: tracked.tracks,
      revoke_failures: failures,
      access_failures: accessFailures,
      reports: reported.reports,
      report_failures: reported.report_failures,
      strategy,
      oracle_actions: did,
      dates,
      discussions,
      total: inbox.total + failures.length + accessFailures.length + reported.unread + (strategy ? 1 : 0) + open + dates.length + tracked.total + discussing + accessRequestRows.length,
    });
  }
  if (runs) return runs;
  const strategy = await routeStrategy(db.strategy, req, p, q, me.role);
  if (strategy) return strategy;

  if (p[1] !== "documents") return notFound("Route");
  if (p.length === 2) {
    const kind = q.get("kind");
    return json(
      200,
      db.documents
        .filter((d) => canSee(me.role, d.visibility))
        .map((d) => documentSummary(db, d))
        .filter((d) => !kind || d.kind === kind),
    );
  }

  const doc = findDocument(db, p[2]);
  if (!doc) return notFound("Document");
  if (p.length === 3) {
    return json(200, { ...documentSummary(db, doc), versions: docVersions(db, doc).map(summary) });
  }
  // H8: who sees the document (owners only, with a reason; the API audits it).
  if (p[3] === "visibility" && p.length === 4 && m === "PATCH") {
    if (me.role !== "owner") return json(403, { detail: "Requires the owner role" });
    const input = await body<Partial<Schemas["VisibilityIn"]>>();
    if (!input?.reason?.trim()) return json(422, { detail: "Give a reason for the change" });
    if (input.visibility !== "company" && input.visibility !== "approvers") return json(422, { detail: "visibility is company or approvers" });
    doc.visibility = input.visibility;
    doc.updated_at = now();
    return json(200, { ...documentSummary(db, doc), versions: docVersions(db, doc).map(summary) });
  }

  if (p[3] === "diff") {
    const from = findVersion(db, doc, Number(q.get("from")));
    const to = findVersion(db, doc, Number(q.get("to")));
    if (!from || !to) return notFound("Version");
    return json(200, {
      document_id: doc.id,
      from_version: from.number,
      to_version: to.number,
      sections: sectionDiff(from.sections, to.sections),
    });
  }

  if (p[3] === "feedback") {
    const status = q.get("status");
    const version = q.get("version");
    tick(llm);
    const items = db.feedback
      .filter((f) => f.document_id === doc.id)
      .filter((f) => !status || f.status === status)
      .filter((f) => !version || f.raised_on_version === Number(version))
      // As the API: by the version raised on, then age.
      .sort((a, b) => a.raised_on_version - b.raised_on_version || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((f) => withSuggestion(db.llm, f, docVersions(db, doc).at(-1)?.number ?? null));
    return json(200, items);
  }

  if (p[3] !== "versions") return notFound("Route");
  if (p.length === 4) {
    if (m === "GET") return json(200, docVersions(db, doc).map(summary));
    return json(501, { detail: "Importing drafts is not available in mock mode" });
  }

  const v = findVersion(db, doc, Number(p[4]));
  if (!v) return notFound("Version");
  const sub = p[5];

  if (!sub) {
    // O4 'document dates': a roadmap's dates against its PRD's schedule bases now.
    const marks =
      doc.kind === "roadmap" && db.roadmap
        ? dateMarks(db.roadmap, v.source?.document_id, v.sections)
        : doc.kind === "update"
          ? updateDateMarks(db.roadmap, v.sections)
          : [];
    return json(200, { ...versionOut(db, v), date_marks: marks });
  }
  if (sub === "markdown") {
    return new Response(versionMarkdown(doc, v), { headers: { "content-type": "text/markdown" } });
  }
  if (sub === "comments") {
    if (m === "POST") {
      const input = await body<Schemas["CommentCreate"]>();
      if (!v.sections.some((s) => s.section_key === input.section_key)) return notFound("Section");
      const c = addComment(db, v, input, { author_id: me.id });
      touch(db, doc.id);
      onFeedback(llm, doc.id, v.number);
      return json(201, commentOut(db, c));
    }
    return json(
      200,
      db.comments
        .filter((c) => c.version_id === v.id && !c.parent_id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((c) => commentOut(db, c)),
    );
  }
  // D13: feedback on the whole draft, a "general" item with no section.
  if (sub === "feedback" && m === "POST") {
    const input = await body<Schemas["GeneralFeedbackCreate"]>();
    const text = (input.body ?? "").trim();
    if (!text || input.body.length > 4000) return json(422, { detail: "Feedback needs 1 to 4,000 characters" });
    const at = now();
    const f: FeedbackRow = {
      id: uuid(),
      document_id: doc.id,
      raised_on_version: v.number,
      kind: "general",
      comment_id: null,
      section_review_id: null,
      section_key: null,
      summary: input.body,
      author_id: me.id,
      anchor: null,
      verdict: null,
      status: "open",
      addressed_in_version: null,
      resolution_note: null,
      severity: input.severity ?? null,
      created_at: at,
      updated_at: at,
    };
    db.feedback.push(f);
    touch(db, doc.id);
    onFeedback(llm, doc.id, v.number);
    return json(201, withSuggestion(db.llm, f));
  }
  if (sub === "sections" && p[7] === "review" && m === "PUT") {
    if (!v.sections.some((s) => s.section_key === p[6])) return notFound("Section");
    // H8: approvers comment and suggest on an update; owners set its verdicts.
    if (doc.kind === "update" && me.role !== "owner") return json(403, { detail: "Only an owner can set a section verdict on an update" });
    const r = addReview(db, v, p[6], await body<Schemas["SectionReviewIn"]>(), { reviewer_id: me.id });
    touch(db, doc.id);
    if (r.feedback_item_id) onFeedback(llm, doc.id, v.number);
    // D10: the last section approved approves the run review of this version.
    followRunReview(db, doc, v, false, me.id);
    return json(200, { ...r, layer: sectionLayer(db, v.id, r.section_key) });
  }
  if (sub === "run-review" && m === "GET") {
    const found = runReviewOf(db, doc.id, v.number);
    if (!found) return json(404, { detail: "no run review for this version" });
    const { run, cp } = found;
    const decider = runReviewDecider(db, cp);
    const reviews = v.sections.map((x) => latestReview(db, v.id, x.section_key));
    const entries = sendBackEntries(runsContext(db), doc.id, v.number);
    const staged = db.feedback.filter((f) => f.document_id === doc.id && isStaged(withSuggestion(db.llm, f).suggestion)).length;
    return json(200, {
      checkpoint_id: cp.id,
      run_id: run.id,
      kind: cp.kind,
      status: cp.status,
      flow_title: run.flow_title,
      approver_role: cp.approver_role,
      sections: {
        total: v.sections.length,
        reviewed: reviews.filter(Boolean).length,
        approved: reviews.filter((x) => x?.verdict === "approved").length,
      },
      feedback: { open: entries - staged, staged, verdicts: reviews.filter((x) => x && x.verdict !== "approved").length },
      wait: { state: "none" },
      decider_id: decider,
      decider_name: decider ? displayName(db.members.find((x) => x.id === decider)?.email ?? decider) : null,
      can_decide: cp.status === "pending" && run.status === "awaiting_checkpoint" && atLeast(me.role, cp.approver_role) && (!decider || decider === me.id),
    });
  }
  if (sub === "feedback-package") {
    return json(200, {
      document_id: doc.id,
      slug: doc.slug,
      title: doc.title,
      version: v.number,
      markdown: versionMarkdown(doc, v),
      open_items: db.feedback.filter(
        (f) => f.document_id === doc.id && f.status === "open" && f.raised_on_version <= v.number,
      ),
      locked_section_keys: lockedKeys(db, v),
      generated_at: now(),
    });
  }
  if (sub === "resolution-report") {
    const items = db.feedback
      .filter((f) => f.document_id === doc.id && f.raised_on_version < v.number)
      .map((f) => withSuggestion(db.llm, f, docVersions(db, doc).at(-1)?.number ?? null));
    const counts: Record<string, number> = {};
    for (const f of items) counts[f.status] = (counts[f.status] ?? 0) + 1;
    return json(200, { document_id: doc.id, version: v.number, items, counts });
  }
  if (sub === "approve" && m === "POST") {
    // F2: the designated decider, when the review policy names one, is the only one who approves.
    const decider = db.review_v2?.policies.find((x) => x.document_id === doc.id)?.decider_id;
    if (decider && decider !== me.id) return json(403, { detail: "Only the designated decider approves this document's versions" });
    // H4: a vision or a product strategy is an owner's to approve.
    const words = doc.kind === "vision" ? "a vision" : doc.kind === "strategy" ? "a product strategy" : doc.kind === "update" ? "an update" : doc.kind === "pricing" ? "a pricing memo" : null;
    if (words && me.role !== "owner") return json(403, { detail: `Only an owner can approve ${words}` });
    // #346: a proposal a later one superseded can't be approved, and says why.
    const superseded = doc.kind === "roadmap" && db.plan_edits && !v.approved_at ? supersededRefusal(db.plan_edits, doc.slug, v.number) : null;
    if (superseded) return json(409, { detail: superseded });
    // #396: a spec version that may be stale is refused, in the app's words; its id in refs.
    const stale = doc.kind === "spec" && !v.approved_at ? staleSpecRefusal((db.specs ??= seedSpecs()), doc.slug, v.number) : null;
    if (stale) return json(422, stale);
    // The publish gate (T2 follow-up): a PRD is refused while blocked, or when not the latest.
    if (doc.kind === "prd") {
      // #254: a version that is still only its template's text is never approved.
      if (!v.approved_at && nothingWritten(db, doc, v.sections)) return json(409, { detail: NOTHING_WRITTEN, blocking: [], dates: [] });
      const latest = docVersions(db, doc).pop()!.number;
      const refusal = publishRefusal(qualityCtx, { documentId: doc.id, slug: doc.slug, versionId: v.id }, v.number, latest, (id) =>
        ensureBlockers(db).blockers.find((b) => b.id === id)?.statement,
      );
      if (refusal) return json(409, refusal);
    }
    // O4 'document dates' (owner, 2026-10-20): not while a date of the roadmap is marked.
    if (doc.kind === "roadmap" && db.roadmap && !v.approved_at) {
      const marked = dateMarks(db.roadmap, v.source?.document_id, v.sections).filter((d) => d.label);
      if (marked.length) {
        return json(409, {
          detail: `${marked.length} date${marked.length === 1 ? " rests" : "s rest"} on no verified basis: ${marked
            .map((d) => `${d.text} (${d.section_key}: ${d.label})`)
            .join(", ")}`,
          blocking: marked.map((d) => ({ key: "unverified_date", id: `${d.section_key}:${d.text}`, title: d.text, rationale: `${d.text} is marked ${d.label}` })),
          dates: marked,
        });
      }
    }
    // H8: an update's dates follow the same rule, against every PRD with an active track.
    if (doc.kind === "update" && !v.approved_at) {
      const marked = updateDateMarks(db.roadmap, v.sections).filter((d) => d.label);
      if (marked.length) {
        return json(409, {
          detail: `${marked.length} date${marked.length === 1 ? " rests" : "s rest"} on no verified basis: ${marked
            .map((d) => `${d.text} (${d.section_key}: ${d.label})`)
            .join(", ")}`,
          blocking: marked.map((d) => ({ key: "unverified_date", id: `${d.section_key}:${d.text}`, title: d.text, rationale: `${d.text} is marked ${d.label}` })),
          dates: marked,
        });
      }
    }
    v.approved_at = now();
    doc.status = "approved";
    doc.updated_at = v.approved_at;
    // D10: publishing the version approves its run review.
    followRunReview(db, doc, v, true, me.id);
    return json(200, { document_id: doc.id, document_status: doc.status, version: summary(v) });
  }
  if (sub === "deck" || (sub === "export" && (q.get("layer") ?? "full") !== "full")) {
    if (!v.sections.some((s) => s.layer === "brief")) {
      return json(422, { detail: `version ${v.number} of '${doc.slug}' has no brief sections; export the full document instead` });
    }
  }
  if (sub === "deck") {
    const versions = docVersions(db, doc);
    return json(
      200,
      deckOut({
        document_id: doc.id,
        slug: doc.slug,
        title: doc.title,
        number: v.number,
        latest: versions[versions.length - 1].number,
        status: v.approved_at ? "approved" : doc.status,
        created_at: v.created_at,
        source: v.source ?? null,
        sections: v.sections,
        citations: v.citations,
        // H8: a board update groups its brief sections into slides (front matter `slides`).
        slides: Array.isArray(v.front_matter.slides) ? (v.front_matter.slides as string[][]) : undefined,
      }),
    );
  }
  if (sub === "export") {
    const format = q.get("format") ?? "html";
    const layer = q.get("layer") ?? "full";
    if (!LAYER_FORMATS[layer]?.includes(format)) {
      return json(422, { detail: `the ${layer} layer exports as ${LAYER_FORMATS[layer]?.join(", ")}, not ${format}` });
    }
    if (layer === "deck") {
      if (format === "pptx") return new Response(`PK mock deck: ${banner(doc, v)}`, { headers: { "content-type": PPTX_TYPE } });
      return new Response(exportPdf(doc, { ...v, sections: v.sections.filter((s) => s.layer === "brief") }), {
        headers: { "content-type": "application/pdf" },
      });
    }
    if (layer === "brief") {
      const brief = { ...v, sections: v.sections.filter((s) => s.layer === "brief") };
      if (format === "pdf") return new Response(exportPdf(doc, brief), { headers: { "content-type": "application/pdf" } });
      return new Response(exportHtml(doc, brief), { headers: { "content-type": "text/html" } });
    }
    if (format === "md") {
      return new Response(`<!-- ${banner(doc, v)} -->\n${versionMarkdown(doc, v)}`, {
        headers: { "content-type": "text/markdown" },
      });
    }
    if (format === "pdf") return new Response(exportPdf(doc, v), { headers: { "content-type": "application/pdf" } });
    return new Response(exportHtml(doc, v), { headers: { "content-type": "text/html" } });
  }
  return notFound("Route");
}

/** One request at a time: each loads the whole db and saves it back, so two in flight would lose a write. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * G8 test hook (mock mode only): `globalThis.__poMockSlack.reply({title, email, text})` stores
 * a reply from the mirrored Slack thread of the discussion titled `title`, as the events
 * endpoint would, from the member with `email`. The page shows it on its next load.
 * `__poMockSlack.fail({title, error})` makes that discussion's mirror failed, as when Slack
 * gives up on its first post; `__poMockSlack.posting({title})` makes it wait for its first
 * post (no thread yet).
 */
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_MOCKS === "1") {
  (globalThis as { __poMockSlack?: unknown }).__poMockSlack = {
    reply: (input: { title: string; email: string; text: string }) => {
      const next = queue.then(() => {
        const db = load();
        const id = injectSlackReply((db.discussions ??= emptyDiscussions()), db.members, input, now(), uuid());
        save(db);
        return id;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    fail: (input: { title: string; error: string }) => {
      const next = queue.then(() => {
        const db = load();
        failSlackMirror((db.discussions ??= emptyDiscussions()), input);
        save(db);
      });
      queue = next.catch(() => undefined);
      return next;
    },
    posting: (input: { title: string }) => {
      const next = queue.then(() => {
        const db = load();
        holdSlackMirror((db.discussions ??= emptyDiscussions()), input);
        save(db);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * Tests seed the mock's data through `__poMockWrite(change)`: the change takes its turn with
 * the app's own calls (each reads the data, answers, then saves it), so a call in flight never
 * saves over a seed. Resolves with what `change` returns, once saved.
 */
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_API_MOCKS === "1") {
  (globalThis as { __poMockWrite?: unknown }).__poMockWrite = <T>(change: (db: Db) => T): Promise<T> => {
    const next = queue.then(() => {
      const db = load();
      const out = change(db);
      save(db);
      return out;
    });
    queue = next.catch(() => undefined);
    return next;
  };
}

export async function mockFetch(req: Request): Promise<Response> {
  // Every call, in order: tests count them (Home's call budget).
  const url = new URL(req.url);
  const log = ((globalThis as { __poMockCalls?: string[] }).__poMockCalls ??= []);
  // Tests act as Oracle's ticker (POST /v1/internal/tick) through this, as they would with page.request against the API.
  (globalThis as { __poMockFetch?: typeof mockFetch }).__poMockFetch ??= mockFetch;
  log.push(`${req.method} ${url.pathname}${url.search}`);
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  if (req.method === "GET" && url.pathname === localStorage.getItem(MOCK_FAIL_KEY)) {
    return new Response(JSON.stringify({ detail: "Mock failure" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  if (localStorage.getItem(MOCK_FAIL_ONCE_KEY) === `${req.method} ${url.pathname}`) {
    localStorage.removeItem(MOCK_FAIL_ONCE_KEY);
    return new Response(JSON.stringify({ detail: "Mock failure" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const next = queue.then(async () => {
    const db = load();
    const res = await route(db, req);
    save(db);
    return res;
  });
  queue = next.catch(() => undefined);
  if (req.method === "GET" && url.pathname === localStorage.getItem(MOCK_SLOW_KEY)) {
    return next.then((res) => new Promise<Response>((r) => setTimeout(() => r(res), MOCK_SLOW_MS)));
  }
  return next;
}
