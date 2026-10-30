/**
 * Mock of the alignment report and company integration routes (F6, mock mode only): the
 * stored reports, who read them, and Oracle's Slack install. A mock transport stands in
 * for Slack: Connect installs at once and sends the browser straight back (a mocked OAuth
 * return), the channels are fixed, and every post succeeds.
 *
 * The "alignment-report" scenario seeds two weekly reports (week of Oct 5, read by the
 * owner, whose Slack post failed; week of Oct 12, unread, posted to #plan), the install
 * and #plan as the report's channel. Every other scenario starts with neither.
 */
import type { Schemas } from "@/lib/api/client";

import { mockSettingValue, setMockSetting } from "./connections";
import type { DiscussionsDb } from "./discussions";
import { mockUuid, seeded } from "./ids";
import { needsReconnect, SLACK_CHANNELS, SLACK_SCENARIO, slackInstall, unlinkAll } from "./slack";

type Report = Schemas["AlignmentReportOut"];
type Track = Schemas["ReportTrack"];
type Integration = Schemas["CompanyIntegrationOut"];
type Role = "viewer" | "commenter" | "approver" | "owner";

export interface ReportsDb {
  reports: (Omit<Report, "read"> & { dismissed?: boolean })[];
  /** Report id -> the member ids who opened it. */
  reads: Record<string, string[]>;
  integration: Integration | null;
}

export const REPORT_SCENARIO = "alignment-report";
const SCENARIO_KEY = "po-mock-scenario";
// Includes a private channel the bot was invited to (the install has groups:read).
const CHANNELS = SLACK_CHANNELS;
const SETTING = "alignment_report";

const ROLE_ORDER: Role[] = ["viewer", "commenter", "approver", "owner"];
const atLeast = (role: Role, min: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
const now = () => new Date().toISOString();

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}
const forbidden = (min: Role) => json(403, { detail: `Requires the ${min} role` });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const title = (kind: Report["kind"], week: string) => `${kind === "weekly" ? "Weekly alignment" : "Alignment so far"} · week of ${shortDay(week)}`;

function headline(s: Schemas["ReportSummaryFigures"]): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return `${s.at_risk + s.off_track} of ${n(s.tracks, "track", "tracks")} at risk; ${n(s.slips, "date", "dates")} slipping as of now; ${n(
    s.untracked_now,
    "Now item has",
    "Now items have",
  )} no issue.`;
}

/**
 * fix4 qa-plan-1, qa-plan-2: a report's tracks come from the roadmap mock's track overviews
 * (./roadmap.ts reportTracks), the ones the Plan reads, as the API's _track_content reads
 * views.overview. `calm` is a quiet week (the seeded week of Oct 5). Each part carries its
 * Now items without an issue for the figures; worst health first, as the API sorts them.
 */
export type LiveTracks = (calm: boolean) => (Track & { untracked_now?: number })[];

const HEALTH_ORDER: Record<string, number> = { off_track: 0, at_risk: 1, no_roadmap: 2, on_track: 3, paused: 4 };

function tracks(live: LiveTracks, calm: boolean): { ts: Track[]; untrackedNow: number } {
  const parts = live(calm).sort((a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || a.prd.title.toLowerCase().localeCompare(b.prd.title.toLowerCase()));
  let untrackedNow = 0;
  const ts = parts.map(({ untracked_now, ...t }) => {
    untrackedNow += untracked_now ?? 0;
    return t;
  });
  return { ts, untrackedNow };
}

/**
 * The figures, from the tracks as the API counts them (qa-plan-56): slips are the slipping
 * items listed under Needs attention; untracked Now items as each track counted them.
 */
function summaryOf(ts: Track[], untrackedNow: number): Schemas["ReportSummaryFigures"] {
  const slips = ts.flatMap((t) => t.needs_attention).filter((n) => n.kind === "slipping").length;
  return {
    tracks: ts.length,
    at_risk: ts.filter((t) => t.health === "at_risk").length,
    off_track: ts.filter((t) => t.health === "off_track").length,
    slips,
    untracked_now: untrackedNow,
    unplanned: ts.flatMap((t) => t.drift).filter((d) => d.kind === "unplanned").length,
    dates_verified: ts.reduce((n, t) => n + t.dates.verified.length, 0),
    dates_withdrawn: ts.reduce((n, t) => n + t.dates.withdrawn.length, 0),
  };
}

/** As oracle.reports.alignment.prd_moved_text (qa-plan-43). */
const prdMovedText = (t: Track) => (t.prd_moved_to ? `v${t.prd_moved_to} of the PRD is approved` : "A newer version of the PRD is approved");
/** As oracle.reports.alignment.rebuild_link (fix4 qa-plan-3): the PRD's Build roadmap, on Plan › Roadmap documents. */
export const rebuildLink = (slug: string) => `/plan/documents?prd=${encodeURIComponent(slug)}`;

function markdown(r: Omit<Report, "read" | "markdown">): string {
  const parts = r.tracks.map((t) =>
    [
      `## ${t.prd.title}`,
      "",
      t.headline,
      ...(t.prd_moved ? [`- ${prdMovedText(t)} · [Build the roadmap from it](${rebuildLink(t.prd.slug)})`] : []),
      ...t.needs_attention.map((n) => `- [${n.title}](${n.link}) · ${n.horizon[0]!.toUpperCase()}${n.horizon.slice(1)}: ${n.detail}`),
    ].join("\n"),
  );
  return [`# ${r.title}`, "", r.headline, "", ...parts].join("\n") + "\n";
}

function makeReport(input: {
  kind: Report["kind"];
  week: string;
  from: string;
  to: string;
  at: string;
  atRisk: boolean;
  slack: Schemas["ReportSlack"];
  live: LiveTracks;
}): Omit<Report, "read"> {
  const { ts, untrackedNow } = tracks(input.live, !input.atRisk);
  const summary = summaryOf(ts, untrackedNow);
  const base = {
    id: mockUuid(),
    kind: input.kind,
    week_start: input.week,
    title: title(input.kind, input.week),
    period: { from: input.from, to: input.to },
    timezone: String(mockSettingValue("company_timezone")),
    generated_at: input.at,
    headline: headline(summary),
    summary,
    slack: input.slack,
    tracks: ts,
    unreadable_tracks: [],
    needs_attention_as_of_now: true,
  };
  return { ...base, markdown: markdown(base) };
}

const PLAN_CHANNEL = { id: "C0PLAN", name: "plan" };

/** The "alignment-report" scenarios: the default company with two weekly reports seeded (fix4: "report-prd-moved" has the Usage alerts PRD's v2 approved too). */
export const REPORT_PRD_MOVED_SCENARIO = "report-prd-moved";
const reportScenario = () => [REPORT_SCENARIO, REPORT_PRD_MOVED_SCENARIO].includes(localStorage.getItem(SCENARIO_KEY) ?? "");

function seedReports(ownerId: string, live: LiveTracks): ReportsDb {
  // Read the tracks before the seed's id scope: reading them may seed the roadmap mock, whose ids stay its own.
  const read = reportScenario() ? { calm: live(true), busy: live(false) } : null;
  const snapshot: LiveTracks = (calm) => structuredClone(calm ? read!.calm : read!.busy);
  return seeded("reports", () => {
    const db: ReportsDb = { reports: [], reads: {}, integration: null };
    // G8 "slack-bridge": the install with the bridge's scopes, and no reports.
    if (localStorage.getItem(SCENARIO_KEY) === SLACK_SCENARIO) db.integration = slackInstall(ownerId, mockUuid(), "2026-10-01T09:00:00Z");
    if (!read) return db;
    const failed = makeReport({
      kind: "weekly",
      week: "2026-10-05",
      from: "2026-10-05T07:00:00Z",
      to: "2026-10-12T07:00:00Z",
      at: "2026-10-12T15:00:12Z",
      atRisk: false,
      live: snapshot,
      slack: { status: "failed", channel: PLAN_CHANNEL, posted_at: null, attempts: 12, error: "channel_not_found", next_attempt_at: null },
    });
    const posted = makeReport({
      kind: "weekly",
      week: "2026-10-12",
      from: "2026-10-12T07:00:00Z",
      to: "2026-10-19T07:00:00Z",
      at: "2026-10-19T15:00:12Z",
      atRisk: true,
      live: snapshot,
      slack: { status: "posted", channel: PLAN_CHANNEL, posted_at: "2026-10-19T15:00:14Z", attempts: 1, error: null, next_attempt_at: null },
    });
    db.reports = [failed, posted];
    db.reads[failed.id] = [ownerId];
    // Installed with F6's scopes before G8: the card asks an owner to reconnect for mirroring.
    db.integration = slackInstall(ownerId, mockUuid(), "2026-10-01T09:00:00Z", ["chat:write", "chat:write.public", "channels:read", "groups:read"]);
    setMockSetting(SETTING, { ...reportSetting(), slack_channel: PLAN_CHANNEL });
    return db;
  });
}

type ReportSetting = { enabled: boolean; weekday: string; time: string; slack_channel: { id: string; name: string } | null };

function reportSetting(): ReportSetting {
  return mockSettingValue(SETTING) as ReportSetting;
}

/** `live` reads the tracks' parts now (./roadmap.ts reportTracks, through the server's roadmap db). */
export function ensureReports(holder: { reports?: ReportsDb }, ownerId: string, live: LiveTracks): ReportsDb {
  holder.reports ??= seedReports(ownerId, live);
  return holder.reports;
}

const out = (db: ReportsDb, r: ReportsDb["reports"][number], me: string): Report => {
  const { dismissed: _dismissed, ...rest } = r;
  void _dismissed;
  return { ...rest, read: (db.reads[r.id] ?? []).includes(me) };
};

/** What the API's GET /v1/inbox adds for owners: the newest weekly reports and the failed posts. */
export function inboxReports(db: ReportsDb, me: { id: string; role: Role }) {
  if (me.role !== "owner") return { reports: [], report_failures: [], unread: 0 };
  const weekly = db.reports.filter((r) => r.kind === "weekly").sort((a, b) => b.week_start.localeCompare(a.week_start)).slice(0, 8);
  const reports: Schemas["InboxReport"][] = weekly.map((r) => ({
    id: r.id,
    kind: r.kind,
    week_start: r.week_start,
    title: r.title,
    headline: r.headline,
    summary: r.summary,
    read: (db.reads[r.id] ?? []).includes(me.id),
    created_at: r.generated_at,
  }));
  const report_failures: Schemas["InboxReportFailure"][] = db.reports
    .filter((r) => r.slack.status === "failed" && !r.dismissed)
    .map((r) => ({
      id: r.id,
      week_start: r.week_start,
      title: `Report not posted to Slack · week of ${shortDay(r.week_start)}`,
      error: r.slack.error ?? null,
      channel: r.slack.channel ?? null,
      attempts: r.slack.attempts ?? 0,
      created_at: r.generated_at,
    }));
  return { reports, report_failures, unread: reports.filter((r) => !r.read).length + report_failures.length };
}

/** This Monday in Los Angeles (the mock company's zone), as YYYY-MM-DD. */
function thisMonday(): string {
  const local = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

function post(db: ReportsDb, channel: ReportSetting["slack_channel"]): Schemas["ReportSlack"] {
  if (!db.integration || !channel) return { status: "not_configured", channel: null, posted_at: null, attempts: 0, error: null, next_attempt_at: null };
  return { status: "posted", channel, posted_at: now(), attempts: 1, error: null, next_attempt_at: null };
}

/** Handles /v1/alignment-reports… and /v1/company-integrations…; null for other routes. */
export async function reportsRoute(holder: { reports?: ReportsDb; discussions?: DiscussionsDb }, ownerId: string, me: { id: string; role: Role }, req: Request, p: string[], q: URLSearchParams, live: LiveTracks): Promise<Response | null> {
  if (p[1] !== "alignment-reports" && p[1] !== "company-integrations") return null;
  const db = ensureReports(holder, ownerId, live);
  const m = req.method;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "company-integrations") {
    if (!atLeast(me.role, "owner")) return forbidden("owner");
    if (!p[2] && m === "GET") return json(200, db.integration ? [db.integration] : []);
    if (p[2] === "slack" && p[3] === "install" && m === "GET") {
      if (db.integration && !needsReconnect(db.integration)) return json(409, { detail: "Slack is already connected; disconnect it first" });
      // The mocked OAuth return: Slack's consent screen is skipped, the install is made (a
      // reconnect keeps the install and gains the bridge's scopes).
      db.integration = db.integration ? { ...db.integration, scopes: slackInstall(me.id, "", "").scopes } : slackInstall(me.id, mockUuid(), now());
      return json(200, { url: "/settings/notifications?connected=slack" });
    }
    if (p[2] === "slack" && p[3] === "channels" && m === "GET") {
      if (!db.integration) return json(409, { detail: "Connect Slack for notifications first" });
      return json(200, CHANNELS);
    }
    if (p[2] === "slack" && p[3] === "test" && m === "POST") {
      if (!db.integration) return json(409, { detail: "Connect Slack for notifications first" });
      const { channel_id } = await body<Schemas["SlackTestIn"]>();
      if (!CHANNELS.some((c) => c.id === channel_id)) return json(502, { detail: "Slack answered channel_not_found" });
      return json(200, { sent: true, channel_id });
    }
    if (p[2] && !p[3] && m === "DELETE") {
      if (!db.integration || db.integration.id !== p[2]) return json(404, { detail: "Integration not found" });
      db.integration = null;
      unlinkAll(holder.discussions);
      const setting = reportSetting();
      if (setting.slack_channel) setMockSetting(SETTING, { ...setting, slack_channel: null });
      return json(204, undefined);
    }
    return json(404, { detail: "Route not found" });
  }

  if (!p[2]) {
    if (m === "GET") {
      const limit = Number(q.get("limit") ?? 50);
      const offset = Number(q.get("offset") ?? 0);
      const rows = [...db.reports].sort((a, b) => b.generated_at.localeCompare(a.generated_at)).slice(offset, offset + limit);
      return json(
        200,
        rows.map((r) => {
          const { tracks: _t, markdown: _m, unreadable_tracks: _u, needs_attention_as_of_now: _n, ...item } = out(db, r, me.id);
          void [_t, _m, _u, _n];
          return item;
        }),
      );
    }
    if (m === "POST") {
      if (!atLeast(me.role, "owner")) return forbidden("owner");
      const { post_to_slack } = (await body<Schemas["AlignmentReportCreate"]>()) ?? {};
      const week = thisMonday();
      const at = now();
      const report = makeReport({
        kind: "on_demand",
        week,
        from: `${week}T07:00:00Z`,
        to: at,
        at,
        atRisk: true,
        live,
        slack: post_to_slack
          ? post(db, reportSetting().slack_channel)
          : { status: "not_requested", channel: null, posted_at: null, attempts: 0, error: null, next_attempt_at: null },
      });
      db.reports.push(report);
      return json(201, { ...report, read: false });
    }
  }
  const row = db.reports.find((r) => r.id === p[2]);
  if (!row) return json(404, { detail: "Report not found" });
  if (!p[3] && m === "GET") return json(200, out(db, row, me.id));
  if (p[3] === "read" && m === "POST") {
    const readers = (db.reads[row.id] ??= []);
    if (!readers.includes(me.id)) readers.push(me.id);
    return json(200, out(db, row, me.id));
  }
  if (p[3] === "slack" && m === "POST") {
    if (!atLeast(me.role, "owner")) return forbidden("owner");
    if (p[4] === "retry") {
      if (!["pending", "failed"].includes(row.slack.status)) return json(409, { detail: `Nothing to retry: the report is ${row.slack.status}` });
      if (!db.integration) return json(409, { detail: "Slack is not connected for notifications: connect it in Settings › Notifications, then retry" });
      row.slack = { ...post(db, row.slack.channel ?? reportSetting().slack_channel), attempts: (row.slack.attempts ?? 0) + 1 };
      row.dismissed = false;
      return json(200, out(db, row, me.id));
    }
    if (p[4] === "dismiss") {
      if (row.slack.status !== "failed") return json(409, { detail: "Only a failed Slack post can be dismissed" });
      row.dismissed = true;
      return json(200, out(db, row, me.id));
    }
  }
  return json(404, { detail: "Route not found" });
}
