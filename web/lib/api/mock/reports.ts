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
import { mockUuid, seeded } from "./ids";

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
const CHANNELS: Schemas["NotificationChannelOut"][] = [
  { id: "C0ENG", name: "eng", is_private: false },
  // A private channel the bot was invited to (the install has groups:read).
  { id: "G0LEADS", name: "leads", is_private: true },
  { id: "C0PLAN", name: "plan", is_private: false },
  { id: "C0PRODUCT", name: "product", is_private: false },
];
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
const plan = (prd: string, key?: string) => `/plan?item=${prd}${key ? `:${key}` : ""}`;

function headline(s: Schemas["ReportSummaryFigures"]): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return `${s.at_risk + s.off_track} of ${n(s.tracks, "track", "tracks")} at risk; ${n(s.slips, "date", "dates")} slipping as of now; ${n(
    s.untracked_now,
    "Now item has",
    "Now items have",
  )} no issue.`;
}

/** The mock company's two tracks, this week: Usage alerts slipping, Checkout on track. */
function tracks(atRisk: boolean): Track[] {
  const alerts: Track = {
    track_id: "5e7a0000-0000-4000-8000-00000000a1e7",
    status: "active",
    prd: { slug: "usage-alerts", title: "Usage alerts PRD" },
    link: plan("usage-alerts"),
    health: atRisk ? "at_risk" : "on_track",
    health_before: "on_track",
    headline: atRisk ? "At risk: 1 of 3 items need attention (1 slipping). Next: First release (2026-11-30)." : "On track: 3 items. Next: First release (2026-11-30).",
    next_milestone: { name: "First release", date: "2026-11-30", verified: true },
    alignment: atRisk ? { aligned: 1, drift: 1, untracked: 1, done: 0 } : { aligned: 2, drift: 0, untracked: 1, done: 0 },
    needs_attention: atRisk
      ? [
          {
            item_key: "threshold-alerts",
            title: "Threshold alerts",
            horizon: "now",
            kind: "slipping",
            detail: "ENG-405 targets 2026-12-09, after the milestone date 2026-11-30.",
            alert_id: null,
            link: plan("usage-alerts", "threshold-alerts"),
          },
        ]
      : [],
    drift: atRisk
      ? [
          {
            kind: "ahead",
            item_key: "digest-emails",
            tracker_ref: null,
            detail: "Engineering has started work planned for next.",
            title: "Digest emails",
            link: plan("usage-alerts", "digest-emails"),
          },
          { kind: "unplanned", item_key: null, tracker_ref: "ENG-431", detail: "ENG-431 (Alert storage cleanup) is not on the roadmap.", title: null, link: null },
        ]
      : [],
    dates: atRisk
      ? {
          verified: [{ reference: "ENG-412", supports_date: "2026-11-30", reason: null }],
          withdrawn: [{ reference: "ENG-413", supports_date: "2026-12-15", reason: "Estimate replaced" }],
        }
      : { verified: [], withdrawn: [] },
    prd_moved: atRisk,
  };
  const checkout: Track = {
    track_id: "5e7a0000-0000-4000-8000-0000000c4ec0",
    status: "active",
    prd: { slug: "checkout-redesign", title: "Checkout redesign PRD" },
    link: plan("checkout-redesign"),
    health: "on_track",
    health_before: "on_track",
    headline: "On track: 4 items. Next: Beta (2026-11-30).",
    next_milestone: { name: "Beta", date: "2026-11-30", verified: true },
    alignment: { aligned: 3, drift: 0, untracked: 1, done: 0 },
    needs_attention: [],
    drift: [],
    dates: { verified: [], withdrawn: [] },
    prd_moved: false,
  };
  return [alerts, checkout];
}

function summaryOf(ts: Track[], slips: number, untrackedNow: number): Schemas["ReportSummaryFigures"] {
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

function markdown(r: Omit<Report, "read" | "markdown">): string {
  const parts = r.tracks.map((t) => [`## ${t.prd.title}`, "", t.headline, ...t.needs_attention.map((n) => `- [${n.title}](${n.link}): ${n.detail}`)].join("\n"));
  return [`# ${r.title}`, "", r.headline, "", ...parts].join("\n") + "\n";
}

function makeReport(input: {
  kind: Report["kind"];
  week: string;
  from: string;
  to: string;
  at: string;
  atRisk: boolean;
  slips: number;
  untrackedNow: number;
  slack: Schemas["ReportSlack"];
}): Omit<Report, "read"> {
  const ts = tracks(input.atRisk);
  const summary = summaryOf(ts, input.slips, input.untrackedNow);
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

function seedReports(ownerId: string): ReportsDb {
  return seeded("reports", () => {
    const db: ReportsDb = { reports: [], reads: {}, integration: null };
    if (localStorage.getItem(SCENARIO_KEY) !== REPORT_SCENARIO) return db;
    const failed = makeReport({
      kind: "weekly",
      week: "2026-10-05",
      from: "2026-10-05T07:00:00Z",
      to: "2026-10-12T07:00:00Z",
      at: "2026-10-12T15:00:12Z",
      atRisk: false,
      slips: 0,
      untrackedNow: 3,
      slack: { status: "failed", channel: PLAN_CHANNEL, posted_at: null, attempts: 12, error: "channel_not_found", next_attempt_at: null },
    });
    const posted = makeReport({
      kind: "weekly",
      week: "2026-10-12",
      from: "2026-10-12T07:00:00Z",
      to: "2026-10-19T07:00:00Z",
      at: "2026-10-19T15:00:12Z",
      atRisk: true,
      slips: 2,
      untrackedNow: 4,
      slack: { status: "posted", channel: PLAN_CHANNEL, posted_at: "2026-10-19T15:00:14Z", attempts: 1, error: null, next_attempt_at: null },
    });
    db.reports = [failed, posted];
    db.reads[failed.id] = [ownerId];
    db.integration = {
      id: mockUuid(),
      provider: "slack",
      purpose: "notifications",
      account_id: "T0EXAMPLE",
      account_label: "Example Co",
      scopes: ["chat:write", "chat:write.public", "channels:read", "groups:read"],
      status: "active",
      last_error: null,
      installed_by: ownerId,
      created_at: "2026-10-01T09:00:00Z",
    };
    setMockSetting(SETTING, { ...reportSetting(), slack_channel: PLAN_CHANNEL });
    return db;
  });
}

type ReportSetting = { enabled: boolean; weekday: string; time: string; slack_channel: { id: string; name: string } | null };

function reportSetting(): ReportSetting {
  return mockSettingValue(SETTING) as ReportSetting;
}

export function ensureReports(holder: { reports?: ReportsDb }, ownerId: string): ReportsDb {
  holder.reports ??= seedReports(ownerId);
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
export async function reportsRoute(holder: { reports?: ReportsDb }, ownerId: string, me: { id: string; role: Role }, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  if (p[1] !== "alignment-reports" && p[1] !== "company-integrations") return null;
  const db = ensureReports(holder, ownerId);
  const m = req.method;
  const body = async <T,>() => JSON.parse((await req.text()) || "null") as T;

  if (p[1] === "company-integrations") {
    if (!atLeast(me.role, "owner")) return forbidden("owner");
    if (!p[2] && m === "GET") return json(200, db.integration ? [db.integration] : []);
    if (p[2] === "slack" && p[3] === "install" && m === "GET") {
      if (db.integration) return json(409, { detail: "Slack is already connected; disconnect it first" });
      // The mocked OAuth return: Slack's consent screen is skipped, the install is made.
      db.integration = {
        id: mockUuid(),
        provider: "slack",
        purpose: "notifications",
        account_id: "T0EXAMPLE",
        account_label: "Example Co",
        scopes: ["chat:write", "chat:write.public", "channels:read", "groups:read"],
        status: "active",
        last_error: null,
        installed_by: me.id,
        created_at: now(),
      };
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
        slips: 2,
        untrackedNow: 4,
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
