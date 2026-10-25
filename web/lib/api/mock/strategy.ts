/**
 * H4 Strategy and vision in mock mode: a synthetic product vision and product strategy (the
 * "strategy" scenario), the strategy stack, drift findings with their waivers, and the
 * owners' Inbox row. Every name here is invented.
 */
import type { Schemas } from "@/lib/api/client";

import type { DocumentSeed } from "./fixtures";

type Finding = Schemas["StrategyFindingOut"];
type Stack = Schemas["StrategyStackOut"];
type Role = Schemas["Me"]["role"];

export type StrategyDb = { findings: Finding[]; stack: Stack; plan_drafts?: Record<string, Schemas["PlanDrift"][]> };

const APPROVED = "2026-10-01T09:00:00Z";
const SEEN = "2026-10-20T07:00:00Z";

const section = (key: string, level: number, heading: string, body = "") => ({ key, level, heading, body });

/** The approved vision (v1) and the product strategy (v1 approved, v2 in review). */
export const STRATEGY_DOCUMENTS: DocumentSeed[] = [
  {
    slug: "vision",
    title: "Vision",
    kind: "vision",
    template: "vision-narrative",
    template_version: "1",
    theme: "editorial-memo",
    versions: [
      {
        number: 1,
        created_at: "2026-09-30T09:00:00Z",
        citations: [],
        brief: ["headline", "future", "for-whom", "beliefs"],
        sections: [
          section("title", 1, "Vision"),
          section("headline", 2, "Headline", "Every small team plans its product like a large one."),
          section("future", 2, "The future we see", "Teams decide from evidence, and every plan traces to a goal."),
          section("for-whom", 2, "Who it is for", "Founders and small product teams."),
          section(
            "beliefs",
            2,
            "What we believe",
            "- Teams plan weekly, not yearly.\n- Founders decide; tools advise.\n- Planning tools sprawl.",
          ),
          section("full", 1, "Full version"),
          section("why-now", 2, "Why now", "Models can read a team's sources."),
          section("sources", 2, "Sources and data points", "None yet."),
        ],
      },
    ],
  },
  {
    slug: "product-strategy",
    title: "Product strategy",
    kind: "strategy",
    template: "product-strategy",
    template_version: "1",
    theme: "editorial-memo",
    versions: [1, 2].map((number) => ({
      number,
      created_at: number === 1 ? "2026-09-30T10:00:00Z" : "2026-10-19T10:00:00Z",
      citations: [],
      brief: ["summary", "focus", "stop"],
      sections: [
        section("title", 1, "Product strategy"),
        section(
          "summary",
          2,
          "Strategy in one paragraph",
          number === 1
            ? "Win self-serve teams first; stop custom reporting."
            : "Win self-serve teams first, then team plans; stop custom reporting.",
        ),
        section("focus", 2, "Focus", "The few problems that matter now."),
        section("choice-self-serve", 3, "Self-serve onboarding", "New teams reach a first plan without help."),
        section("choice-team-plans", 3, "Team plans", "Teams of five or more share one plan."),
        section("stop", 2, "What we stop or won't do", "What we stop."),
        section("choice-custom-reports", 3, "Custom report builder", "Stops: one-off reports for single accounts."),
        section("full", 1, "Full version"),
        section("insights", 2, "Insights", "Teams that plan in their first week stay."),
        section("tradeoffs", 2, "Trade-offs and risks", "Large accounts wait longer."),
        section("sources", 2, "Sources and data points", "None yet."),
      ],
    })),
  },
];

function finding(id: string, extra: Partial<Finding>): Finding {
  return {
    id,
    kind: "goal_without_strategy",
    severity: "warning",
    subject_kind: "entity",
    subject_id: null,
    subject_ref: "",
    strategy_version_id: null,
    detail: {},
    status: "open",
    waived_by: null,
    waived_at: null,
    waive_reason: null,
    first_seen_at: SEEN,
    last_seen_at: SEEN,
    resolved_at: null,
    ...extra,
  };
}

type GoalRow = { id: string; type: string; key: string; title: string };

/**
 * Four open findings (two high: items still planned under the stop choice) and one waived.
 * The focus goals are the mock baseline's own (`entities`), so their distance to go is the
 * baseline's; `vision: false` is the company with a strategy and no vision yet.
 */
export function seedStrategy(uuid: () => string, entities: GoalRow[] = [], { vision = true } = {}): StrategyDb {
  const node = (key: string, title: string) => {
    const e = entities.find((x) => x.type === "goal" && x.key === key);
    return e ? { id: e.id, key: e.key, title: e.title } : { id: uuid(), key, title };
  };
  const activation = node("g.activation", "Raise activation");
  const conversion = node("g.paid-conversion", "Grow paid conversion");
  const retention = node("retention", "Retention");
  const reports = node("custom-reports", "Custom report builder");
  const items = [uuid(), uuid(), uuid()];
  const findings = [
    finding(uuid(), { subject_id: retention.id, subject_ref: "goal:retention" }),
    finding(uuid(), {
      kind: "outside_strategy",
      subject_kind: "roadmap_item",
      subject_id: items[0],
      subject_ref: "dark-mode",
      detail: { horizon: "next", title: "Dark mode", draft: false },
    }),
    ...items.slice(1).map((id, i) =>
      finding(uuid(), {
        kind: "stopped_but_planned",
        severity: "high",
        subject_kind: "roadmap_item",
        subject_id: id,
        subject_ref: i === 0 ? "report-export" : "report-scheduling",
        detail: { horizon: i === 0 ? "now" : "next", title: i === 0 ? "Report export" : "Report scheduling", draft: false },
      }),
    ),
    finding(uuid(), {
      kind: "focus_without_goal",
      subject_ref: "strategy_choice:product-strategy-team-plans",
      status: "waived",
      waived_at: "2026-10-20T08:00:00Z",
      waive_reason: "The goal is being proposed this week.",
    }),
  ];
  const doc = (slug: string, title: string, version: number) => ({ slug, title, version, approved_at: APPROVED });
  return {
    findings,
    stack: {
      vision: !vision ? null : {
        document: doc("vision", "Vision", 1),
        headline: "Every small team plans its product like a large one.",
        horizon_years: 5,
        beliefs: [
          { id: "weekly", statement: "Teams plan weekly, not yearly.", status: "supported", evidence: 3 },
          { id: "founders", statement: "Founders decide; tools advise.", status: "untested", evidence: 0 },
          { id: "sprawl", statement: "Planning tools sprawl.", status: "strained", evidence: 1 },
        ],
        review_on: "2031-10-01",
      },
      strategy: {
        document: doc("product-strategy", "Product strategy", 1),
        summary: "Win self-serve teams first; stop custom reporting.",
        review_on: "2027-10-01",
        choices: [
          { entity_id: uuid(), id: "self-serve", title: "Self-serve onboarding", stance: "focus", goals: [{ ...activation, items: 3 }, { ...conversion, items: 2 }], features: [], items: 4, open_findings: 0 },
          { entity_id: uuid(), id: "team-plans", title: "Team plans", stance: "focus", goals: [], features: [], items: 1, open_findings: 0 },
          { entity_id: uuid(), id: "custom-reports", title: "Custom report builder", stance: "stop", goals: [], features: [reports], items: 2, open_findings: 2 },
        ],
      },
      unaligned: {
        goals: [retention],
        items: [{ roadmap_item_id: items[0], title: "Dark mode", draft: false }],
      },
      counts: { open: 4, high: 2, waived: 1 },
    },
  };
}

/**
 * A company with no approved strategy (nor vision): the only finding is the open
 * `no_strategy` one, which belongs to no stack row (and is info, so the stack counts skip it).
 */
export function seedNoStrategy(uuid: () => string): StrategyDb {
  return {
    findings: [finding(uuid(), { kind: "no_strategy", severity: "info", subject_kind: "document", subject_ref: "strategy" })],
    stack: { vision: null, strategy: null, unaligned: { goals: [], items: [] }, counts: { open: 0, high: 0, waived: 0 } },
  };
}

const open = (db: StrategyDb) => db.findings.filter((f) => f.status === "open" && f.severity !== "info");

/** The owners' Inbox row (null for others, or with nothing open), as the API. */
export function inboxStrategy(db: StrategyDb | undefined, role: Role): Schemas["InboxStrategy"] | null {
  if (!db || role !== "owner") return null;
  const rows = open(db);
  if (!rows.length) return null;
  return {
    new_findings: rows.length,
    high: rows.filter((f) => f.severity === "high").length,
    href: "/company/strategy",
    since: rows.map((f) => f.first_seen_at).sort().at(-1)!,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** /v1/strategy/*: the stack, findings, waive (owners; approvers for outside_strategy) and check. */
export async function routeStrategy(db: StrategyDb | undefined, req: Request, p: string[], q: URLSearchParams, role: Role) {
  if (p[1] !== "strategy") return null;
  const empty: StrategyDb = db ?? {
    findings: [],
    stack: { vision: null, strategy: null, unaligned: { goals: [], items: [] }, counts: { open: 0, high: 0, waived: 0 } },
  };
  if (p[2] === "stack" && req.method === "GET") {
    const rows = open(empty);
    const counts = {
      open: rows.length,
      high: rows.filter((f) => f.severity === "high").length,
      waived: empty.findings.filter((f) => f.status === "waived").length,
    };
    return json(200, { ...empty.stack, counts });
  }
  if (p[2] === "findings" && p.length === 3 && req.method === "GET") {
    const status = q.get("status") ?? "open";
    const kind = q.get("kind");
    return json(
      200,
      empty.findings.filter((f) => (!status || f.status === status) && (!kind || f.kind === kind)),
    );
  }
  if (p[2] === "findings" && p[4] === "waive" && req.method === "POST") {
    const f = empty.findings.find((x) => x.id === p[3]);
    if (!f) return json(404, { detail: "Finding not found" });
    const needed = f.kind === "outside_strategy" ? ["approver", "owner"] : ["owner"];
    if (!needed.includes(role)) return json(403, { detail: `Requires the ${needed[0]} role` });
    const reason = String(((await req.json().catch(() => ({}))) as { reason?: string }).reason ?? "").trim();
    if (!reason) return json(422, { detail: "a waiver needs a reason" });
    if (f.status !== "open") return json(409, { detail: `The finding is ${f.status}` });
    Object.assign(f, { status: "waived", waived_at: new Date().toISOString(), waive_reason: reason });
    return json(200, f);
  }
  if (p[2] === "check" && req.method === "POST") {
    if (role !== "owner") return json(403, { detail: "Requires the owner role" });
    return json(200, { opened: 0, resolved: 0 });
  }
  return json(404, { detail: "Route not found" });
}

type PlanDrift = Schemas["PlanDrift"];
const ITEM_LABEL: Record<PlanDrift["kind"], string> = {
  outside_strategy: "Outside the strategy",
  stopped_but_planned: "Stopped in the strategy",
};

/**
 * The "strategy-plan" scenario: findings on the mock Plan's own items (H4 §5 on Plan), on
 * top of the strategy scenario's. Approved items carry stored findings (`detail.plan_key`
 * names the item; `detail.text` holds the sentence the API words as the Plan is read); the
 * roadmap draft's items are measured live (`plan_drafts`), with no finding to waive.
 */
export function seedPlanDrift(db: StrategyDb, uuid: () => string, entities: GoalRow[] = []): StrategyDb {
  const churn = entities.find((e) => e.type === "goal" && e.key === "g.early-churn")?.title ?? "Cut early churn";
  db.findings.push(
    finding(uuid(), {
      kind: "stopped_but_planned",
      severity: "high",
      subject_kind: "roadmap_item",
      subject_id: uuid(),
      subject_ref: "slack-alerts",
      detail: { plan_key: "slack-alerts", horizon: "now", title: "Alerts in the team chat", draft: false,
        text: "The product strategy stops Custom report builder, and this item is in Now." },
    }),
    finding(uuid(), {
      kind: "outside_strategy",
      subject_kind: "roadmap_item",
      subject_id: uuid(),
      subject_ref: "team-budgets",
      detail: { plan_key: "team-budgets", horizon: "later", title: "Budgets per team", draft: false,
        text: `${churn} is under no focus choice of the product strategy.` },
    }),
  );
  db.plan_drafts = {
    "spend-forecast": [
      { kind: "outside_strategy", severity: "warning", label: ITEM_LABEL.outside_strategy, status: "open", finding_id: null,
        waive_reason: null, waived_at: null, text: "It serves no goal, so the product strategy does not cover it." },
    ],
  };
  return db;
}

/** A Plan item's drift, as GET /v1/plan gives it: owners and approvers only. */
export function planDrift(db: StrategyDb | undefined, role: Role, key: string, origin: "approved" | "draft"): PlanDrift[] {
  if (!db || (role !== "owner" && role !== "approver")) return [];
  if (origin === "draft") return db.plan_drafts?.[key] ?? [];
  return db.findings
    .filter((f) => f.subject_kind === "roadmap_item" && f.detail?.plan_key === key && (f.status === "open" || f.status === "waived"))
    .filter((f): f is Finding & { kind: PlanDrift["kind"] } => f.kind === "outside_strategy" || f.kind === "stopped_but_planned")
    .map((f) => ({
      kind: f.kind,
      severity: f.severity === "high" ? "high" : "warning",
      label: ITEM_LABEL[f.kind],
      text: String(f.detail?.text ?? ""),
      status: f.status === "waived" ? "waived" : "open",
      finding_id: f.id,
      waive_reason: f.waive_reason,
      waived_at: f.waived_at,
    }));
}
