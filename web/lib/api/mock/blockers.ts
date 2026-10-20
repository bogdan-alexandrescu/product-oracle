/**
 * Mock of the blocker strategy routes (api/oracle/blockers/router.py) for
 * NEXT_PUBLIC_API_MOCKS=1. Blockers are baseline constraints with a strategy; their
 * options, experiments and resolution events are the v2 rows of ./v2.ts, so the
 * foundation's read routes (/v1/blocker-options ...) see every write made here.
 *
 * Simplified on purpose: the readiness gate (a critical hard blocker that is open or
 * mitigating is critical), the policy screen (a few prohibited tactics) and the
 * rendering mirror the API's rules, not its every message. Synthetic placeholders only.
 */
import type { Schemas } from "@/lib/api/client";

import type { BaselineState } from "./baseline";
import { V2_IDS, type V2Db } from "./v2";

type BlockerRow = Omit<Schemas["BlockerOut"], "gate" | "impacted" | "limit_kind_label">;
type Option = Schemas["BlockerOptionOut"];
type Experiment = Schemas["FeasibilityExperimentOut"];
type ResolutionEvent = Schemas["BlockerResolutionEventOut"];
type Gate = Schemas["BlockerGate"];
type Role = "viewer" | "commenter" | "approver" | "owner";

export interface BlockersDb {
  blockers: BlockerRow[];
  acceptances: Schemas["AssumptionDecisionOut"][];
}

export interface BlockersContext {
  userId: string;
  role: Role;
  v2: V2Db;
  documents: { id: string; slug: string; title: string }[];
  /** The baseline, for blockers recorded on an existing constraint (`entity_id`). */
  baseline?: BaselineState;
}

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, approver: 2, owner: 3 };
const SEVERITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const LABELS: Record<string, string> = {
  capacity: "Rate or capacity limit",
  eligibility: "API eligibility",
  permission: "Permissions",
  policy: "Third-party policy",
  other: "Other constraint",
};
const PROHIBITED =
  "Oracle never proposes evading platform restrictions, abusing identities or accounts, or messaging people without their permission.";
const PATHS: Record<string, Schemas["BlockerCompliantPath"][]> = {
  capacity: [
    { approach: "architecture", label: "Efficiency", guidance: "Batch, cache and deduplicate calls so peak use stays under the published limit." },
    { approach: "operations", label: "Queue within the permitted rate", guidance: "Queue work and back off when the provider signals the limit; tell users when a result is delayed." },
    { approach: "partnership", label: "Higher tier or quota", guidance: "Request a higher quota or a paid tier through the provider's own process." },
    { approach: "alternative_workflow", label: "Fewer calls by design", guidance: "Change the workflow so fewer calls are needed (digests, on-demand refresh)." },
  ],
  eligibility: [
    { approach: "partnership", label: "Approved program or entitlement", guidance: "Apply for the provider's approved API program, partner status or entitlement." },
    { approach: "alternative_workflow", label: "A workflow that does not need the gated API", guidance: "Deliver the outcome through features available to every integration." },
    { approach: "distribution", label: "Channel diversification", guidance: "Offer the outcome through a channel or integration where the product is eligible." },
  ],
  permission: [
    { approach: "alternative_workflow", label: "Explicit opt-in", guidance: "People grant access themselves (OAuth consent with the needed scopes, opt-in settings) and can revoke it." },
    { approach: "direct_remedy", label: "Request the permission", guidance: "Request the scope or permission through the provider's review process." },
    { approach: "operations", label: "Assisted step", guidance: "Keep a person in the loop for the step automation is not permitted to do." },
  ],
  policy: [
    { approach: "alternative_workflow", label: "Opt-in interactions", guidance: "Interact only with people who asked for it; they start the conversation or subscribe." },
    { approach: "partnership", label: "Negotiated or sanctioned access", guidance: "Agree terms with the platform, or use its sanctioned integration." },
    { approach: "distribution", label: "Another channel", guidance: "Move the interaction to a channel whose policy allows it." },
  ],
};
const SCREEN: [Schemas["BlockerPolicyFlag"]["category"], RegExp, string][] = [
  ["evasion", /\b(bypass|circumvent|evade|rotat\w* prox\w*|spoof\w*)\b/i, "Evades a platform restriction (limits, detection, terms)"],
  ["identity_abuse", /\b(fake|extra|multiple|bought|aged) accounts?\b|\bimpersonat\w*/i, "Abuses identities or accounts"],
  ["unauthorized_messaging", /\b(unsolicited|mass dm|bulk messag\w*|without (their )?consent)\b/i, "Messages people without their permission"],
];

const AT = "2026-10-19T09:00:00Z";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const now = () => new Date().toISOString();

/** The fields a PATCH body sets, minus its bookkeeping keys. */
function given(input: object, skip: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && !skip.includes(k)));
}

/** Fixed ids of the Quillfield deposits blocker and the question asked about it. */
export const DEPOSITS_IDS = {
  blocker: "a3000000-0000-4000-8000-000000000001",
  requirement: "a3000000-0000-4000-8000-000000000002",
  gap: "a3000000-0000-4000-8000-000000000003",
  question: "a3000000-0000-4000-8000-000000000004",
} as const;

/** The deposits PRD's critical blocker, plus the gap and question that ask about it. */
function depositsBlocker(documentId: string, userId: string, v2: V2Db): BlockerRow {
  const asked = new Date(Date.now() - 86_400_000).toISOString();
  v2.gaps.push({
    id: DEPOSITS_IDS.gap, intake_id: null, document_id: documentId, category: "blockers",
    statement: "Same-day refund rule unanswered", impact: ["feasibility"], importance: "critical", evidence_ids: [],
    confidence: null, knowledge_state: "unknown", status: "asked", owner_id: userId, related_modules: ["constraints.solutions"],
    stop_condition: null, entity_ids: [DEPOSITS_IDS.blocker], section_keys: ["risks"], created_by: userId, lock_version: 1,
    created_at: asked, updated_at: asked,
  });
  v2.questions.push({
    id: DEPOSITS_IDS.question, gap_id: DEPOSITS_IDS.gap, intake_id: null, document_id: documentId,
    category: "blockers", prompt: "Same-day cancellation refund?", rationale: null, priority: 1, batch: null,
    asked_to: userId, asked_by: userId, module_key: "constraints.solutions", section_key: "risks", status: "asked",
    created_at: asked, updated_at: asked,
  });
  return {
    id: DEPOSITS_IDS.blocker,
    key: "same-day-refund",
    statement: "Same-day refund rule unanswered",
    detail: null,
    entity_status: "confirmed",
    locked: false,
    confidence: 0.6,
    evidence_count: 0,
    type: "hard",
    limit_kind: "policy",
    third_party: "Example card processor",
    severity: "critical",
    status: "open",
    timing: "Every same-day cancellation",
    threshold: null,
    impacted_entity_ids: [DEPOSITS_IDS.requirement],
    impacted_users: ["Patients who cancel on the day"],
    owner_id: userId,
    review_at: null,
    document_ids: [documentId],
    scaling: { tenants: "Every clinic", blast_radius: "One booking at a time" },
    selected_option_id: null,
    revision: 1,
    created_at: AT,
    updated_at: AT,
  };
}

/**
 * The ``critical_blockers`` readiness check for a document, as the API's evaluates it:
 * critical when a gating blocker is critical, else warning, pass or not_applicable.
 */
export function documentGate(db: BlockersDb, documentId: string): { status: Gate["status"]; rationale: string; evidence_ids: string[] } {
  const rows = db.blockers.filter((b) => b.document_ids.includes(documentId)).map((b) => ({ b, g: gate(b) }));
  if (!rows.length) return { status: "not_applicable", rationale: "No blockers are linked to this document.", evidence_ids: [] };
  const critical = rows.filter((r) => r.g.status === "critical");
  const warnings = rows.filter((r) => r.g.status === "warning");
  const shown = critical.length ? critical : warnings.length ? warnings : rows;
  const status = critical.length ? "critical" : warnings.length ? "warning" : "pass";
  return { status, rationale: shown.map((r) => `${r.g.rationale}.`).join(" "), evidence_ids: shown.map((r) => r.b.id) };
}

export function seedBlockers(documentId: string, userId: string, deposits?: { documentId: string; v2: V2Db }): BlockersDb {
  return {
    blockers: [
      {
        id: V2_IDS.blocker,
        key: "address-lookup-rate-limit",
        statement: "The address lookup service allows 100 requests a minute per company",
        detail: null,
        entity_status: "confirmed",
        locked: true,
        confidence: 0.8,
        evidence_count: 0,
        type: "hard",
        limit_kind: "capacity",
        third_party: "Example address service",
        severity: "critical",
        status: "mitigating",
        timing: "At launch, when every company syncs at once",
        threshold: "More than 100 requests a minute per company",
        impacted_entity_ids: [V2_IDS.requirement],
        impacted_users: ["Returning buyers"],
        owner_id: userId,
        review_at: null,
        document_ids: [documentId],
        scaling: { tenants: "Each company has its own quota", blast_radius: "One company at a time" },
        selected_option_id: null,
        revision: 1,
        created_at: AT,
        updated_at: AT,
      },
      ...(deposits ? [depositsBlocker(deposits.documentId, userId, deposits.v2)] : []),
    ],
    acceptances: [],
  };
}

function flags(o: { title: string; description?: string | null; details?: Record<string, unknown> }) {
  const text = [o.title, o.description ?? "", ...Object.values(o.details ?? {}).filter((v) => typeof v === "string")].join(" \n ");
  return SCREEN.flatMap(([category, rx, message]) => {
    const m = text.match(rx);
    return m ? [{ category, match: m[0], message }] : [];
  });
}

function gate(b: BlockerRow): Gate {
  const unresolved = b.status === "open" || b.status === "mitigating";
  if (b.type === "hard" && b.severity === "critical") {
    return unresolved
      ? { status: "critical", rationale: `Critical hard blocker '${b.statement}' (${b.key}) is unresolved (${b.status}); resolve it, approve a scoped feasibility experiment or accept the risk` }
      : { status: "pass", rationale: `'${b.statement}' (${b.key}) is ${b.status.replace("_", " ")}` };
  }
  if (unresolved && (b.type === "hard" || b.type === "unknown" || b.severity === "critical")) {
    return { status: "warning", rationale: `'${b.statement}' (${b.key}) is ${b.status}; research it or decide a path` };
  }
  return { status: "pass", rationale: `'${b.statement}' (${b.key}) does not stop a publish` };
}

function recommended(options: Option[]): string | null {
  const score: Record<string, number> = { high: 3, medium: 2, low: 1, unknown: 0 };
  const ok = options.filter((o) => o.compliance === "compliant" && o.status !== "rejected" && flags(o).length === 0);
  ok.sort((a, b) => score[b.technical_feasibility] + score[b.policy_feasibility] - (score[a.technical_feasibility] + score[a.policy_feasibility]));
  return ok[0]?.id ?? null;
}

function strategy(ctx: BlockersContext, db: BlockersDb, b: BlockerRow): Schemas["BlockerStrategy"] {
  const g = gate(b);
  const options = ctx.v2.blocker_options.filter((o) => o.blocker_id === b.id);
  const rec = recommended(options);
  const docs = ctx.documents.filter((d) => b.document_ids.includes(d.id));
  return {
    blocker: { ...b, limit_kind_label: LABELS[b.limit_kind], impacted: [], gate: g },
    gate: g,
    evidence: [],
    options: options.map((o) => ({ ...o, policy_flags: flags(o), recommended: o.id === rec })),
    recommended_option_id: rec,
    compliant_paths: PATHS[b.limit_kind] ?? [],
    prohibited: PROHIBITED,
    experiments: ctx.v2.feasibility_experiments.filter((x) => x.blocker_id === b.id),
    events: ctx.v2.blocker_events.filter((e) => e.blocker_id === b.id).sort((x, y) => x.created_at.localeCompare(y.created_at)),
    risk_acceptance: b.status === "accepted_risk" ? (db.acceptances.filter((a) => a.entity_id === b.id).at(-1) ?? null) : null,
    documents: docs.map((d) => ({ id: d.id, slug: d.slug, title: d.title })),
  };
}

function ordered(rows: Schemas["BlockerStrategy"][]) {
  const g: Record<string, number> = { critical: 0, warning: 1, pass: 2, not_applicable: 3 };
  return rows.sort((a, b) => SEVERITY[a.blocker.severity] - SEVERITY[b.blocker.severity] || g[a.gate.status] - g[b.gate.status]);
}

const words = (v: unknown) => String(v).replace(/_/g, " ");

/** The API's computed ``summary`` (oracle.v2.schemas.describe_blocker_event). */
export function describeEvent(e: Pick<ResolutionEvent, "kind" | "from_status" | "to_status" | "data">): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  const gate = (data.gate ?? {}) as Record<string, unknown>;
  if (data.change === "reclassified") {
    const before = (data.before ?? {}) as Record<string, unknown>;
    const stays = `status stays ${words(gate.status ?? "unknown")}`;
    const was = `${before.type} ${before.severity}`;
    const is = `${gate.type} ${gate.severity}`;
    return was !== is ? `Reclassified from ${words(was)} to ${words(is)} (${stays})` : `Gated documents changed (${stays})`;
  }
  if (data.change === "reopened_by_reclassification" || data.change === "confirmed") {
    const what = (data.withdrawn ?? data.confirmed) === "accepted_risk" ? "risk acceptance" : "feasibility scope";
    const is = words(`${gate.type} ${gate.severity}`);
    if (data.change === "confirmed") return `${what.charAt(0).toUpperCase()}${what.slice(1)} confirmed on reclassification to ${is}`;
    return `Reopened by reclassification to ${is} (the ${what} needs an ${String(data.role ?? "owner")})`;
  }
  if (data.change === "legacy_snapshot") return `Gate snapshot recorded for an older blocker (${words(gate.status)})`;
  if (e.kind === "experiment_started" || e.kind === "experiment_concluded") return `Experiment ${words(data.to ?? e.kind.replace("experiment_", ""))}`;
  if (e.to_status && e.from_status && e.to_status !== e.from_status) return `Status changed from ${words(e.from_status)} to ${words(e.to_status)}`;
  if (e.to_status && !e.from_status) return `Status set to ${words(e.to_status)}`;
  const k = words(e.kind);
  return k.charAt(0).toUpperCase() + k.slice(1);
}

const gating = (b: Pick<BlockerRow, "type" | "severity">) => b.type === "hard" && b.severity === "critical";
const snapshot = (b: BlockerRow) => ({ type: b.type, severity: b.severity, status: b.status, document_ids: [...b.document_ids].sort() });
type Snapshot = ReturnType<typeof snapshot>;
// Gates less than a gating `before`: no longer critical and hard, or fewer documents.
const weakens = (before: Snapshot | undefined, after: Snapshot) =>
  !!before && gating(before) && (!gating(after) || before.document_ids.some((d) => !after.document_ids.includes(d)));

/** For a resolved blocker, the gate its resolution recorded, or the one an owner reclassified it to since. */
function resolveFloor(ctx: BlockersContext, b: BlockerRow): Snapshot | undefined {
  const events = ctx.v2.blocker_events.filter((e) => e.blocker_id === b.id);
  const at = events.map((e) => !!e.to_status).lastIndexOf(true);
  if (at < 0 || events[at].to_status !== "resolved") return undefined;
  let floor = (events[at].data as { gate?: Snapshot }).gate;
  for (const e of events.slice(at + 1)) {
    const data = e.data as { change?: string; by_decider?: boolean; gate?: Snapshot };
    if (data.change === "reclassified" && data.by_decider === true && data.gate) floor = data.gate;
  }
  return floor;
}

function event(ctx: BlockersContext, b: BlockerRow, kind: ResolutionEvent["kind"], to: BlockerRow["status"] | null, extra: Partial<ResolutionEvent> = {}) {
  const row = {
    id: crypto.randomUUID(),
    blocker_id: b.id,
    option_id: null,
    experiment_id: null,
    kind,
    from_status: to ? b.status : null,
    to_status: to,
    reason: null,
    actor: `user:${ctx.userId}`,
    data: {},
    created_at: now(),
    ...extra,
  };
  ctx.v2.blocker_events.push({ ...row, summary: describeEvent(row) });
  if (to) b.status = to;
  b.revision += 1;
  b.updated_at = now();
}

function render(blockers: BlockerRow[], options: Option[]): Schemas["BlockerModuleRender"] {
  const rows = [...blockers].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  const pathOf = (b: BlockerRow) => options.find((o) => o.blocker_id === b.id && o.status === "selected")?.title ?? "No path selected yet";
  const brief = rows.length
    ? [
        "## Blockers and solution strategy {#constraints-solutions}",
        "",
        "| Blocker | Kind | Severity | Status | Path |",
        "|---|---|---|---|---|",
        ...rows.map((b) => `| [${b.statement}](#blocker-${b.key}) | ${b.type}, ${LABELS[b.limit_kind].toLowerCase()} | ${b.severity} | ${b.status} | ${pathOf(b)} |`),
      ]
    : ["## Blockers and solution strategy {#constraints-solutions}", "", "No known blockers."];
  const full = [
    "## Constraints, blockers and solution strategy {#constraints-solutions-detail}",
    ...rows.flatMap((b) => ["", `### ${b.statement} {#blocker-${b.key}}`, "", `- **Type:** ${b.type}. **Kind:** ${LABELS[b.limit_kind]}.`, `- **Threshold:** ${b.threshold ?? "-"}`, "", `Selected: ${pathOf(b)}.`]),
  ];
  const evidence: Record<string, string[]> = { "constraints-solutions": [], "constraints-solutions-detail": [] };
  for (const b of rows) evidence[`blocker-${b.key}`] = [];
  return {
    module_key: "constraints.solutions",
    brief_section_id: "constraints-solutions",
    full_section_id: "constraints-solutions-detail",
    section_ids: Object.keys(evidence),
    brief_markdown: brief.join("\n"),
    full_markdown: full.join("\n"),
    citations: [],
    evidence_by_section: evidence,
    data_points: rows.filter((b) => b.threshold).map((b) => `${b.statement}: threshold ${b.threshold} (no source yet)`),
    appendix_markdown: Object.keys(evidence).map((k) => `- ${k}: no supporting sources yet`).join("\n"),
  };
}

/** The blocker strategy routes; null when the path is not one of them. */
export async function routeBlockers(ctx: BlockersContext, db: BlockersDb, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const can = (role: Role) => RANK[ctx.role] >= RANK[role];
  const forbidden = (role: Role) => json(403, { detail: `Requires the ${role} role` });
  const find = (id: string) => db.blockers.find((b) => b.id === id);

  // From a document: /v1/documents/{doc}/blocker-strategy[/render]
  if (p[1] === "documents" && p[3] === "blocker-strategy" && m === "GET") {
    const doc = ctx.documents.find((d) => d.id === p[2] || d.slug === p[2]);
    if (!doc) return json(404, { detail: `document '${p[2]}' not found` });
    const linked = db.blockers.filter((b) => b.document_ids.includes(doc.id));
    if (p[4] === "render") return json(200, render(linked, ctx.v2.blocker_options));
    const blockers = ordered(linked.map((b) => strategy(ctx, db, b)));
    const worst = blockers.find((s) => s.gate.status === "critical") ?? blockers.find((s) => s.gate.status === "warning");
    const readiness: Gate = !blockers.length
      ? { status: "not_applicable", rationale: "No blockers are linked to this document." }
      : (worst?.gate ?? { status: "pass", rationale: blockers.map((s) => s.gate.rationale).join(". ") });
    return json(200, { document: { id: doc.id, slug: doc.slug, title: doc.title }, readiness, blockers });
  }

  if (p[1] === "blockers") {
    if (p.length === 2 && m === "GET") {
      const rows = db.blockers
        .filter((b) => !q.get("document_id") || b.document_ids.includes(q.get("document_id")!))
        .filter((b) => ["status", "type", "severity", "limit_kind"].every((k) => !q.get(k) || String(b[k as keyof BlockerRow]) === q.get(k)))
        .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])
        .map((b) => ({ id: b.id, key: b.key, statement: b.statement, type: b.type, limit_kind: b.limit_kind, third_party: b.third_party, severity: b.severity, status: b.status, selected_option_id: b.selected_option_id, document_ids: b.document_ids, gate: gate(b), updated_at: b.updated_at }));
      return json(200, rows);
    }
    if (p.length === 2 && m === "POST") {
      if (!can("approver")) return forbidden("approver");
      const input = await body<Schemas["BlockerCreate"]>();
      if (!input.entity_id === !input.key) return json(422, { detail: "Give either entity_id (an existing constraint) or key and statement" });
      if (!input.entity_id && !input.statement) return json(422, { detail: "A new blocker needs both a key and a statement" });
      // An existing constraint, e.g. an intake answer's suggested blocker (B4 promote).
      const from = input.entity_id ? ctx.baseline?.entities.find((e) => e.id === input.entity_id) : undefined;
      if (input.entity_id && !from) return json(404, { detail: "Blocker not found" });
      if (from && from.type !== "constraint") return json(422, { detail: `${from.type}:${from.key} is a ${from.type}, not a constraint` });
      if (input.third_party && (!input.limit_kind || input.limit_kind === "other")) {
        return json(422, { detail: "Classify a third-party limit: capacity (rate or capacity), eligibility (API eligibility), permission or policy" });
      }
      if (from && (from.attrs?.blocker || db.blockers.some((b) => b.id === from.id))) {
        return json(409, { detail: `constraint:${from.key} is already a blocker; PATCH it` });
      }
      if (!from && db.blockers.some((b) => b.key === input.key)) return json(409, { detail: `constraint:${input.key} already exists; give its entity_id` });
      const evidence = from ? (ctx.baseline?.evidence.filter((e) => e.entity_id === from.id) ?? []) : [];
      const b: BlockerRow = {
        id: from?.id ?? crypto.randomUUID(), key: from?.key ?? input.key!, statement: input.statement ?? from!.title,
        detail: input.detail !== undefined ? input.detail : (from?.body ?? null), entity_status: from?.status ?? "confirmed", locked: true,
        confidence: from?.confidence ?? null, evidence_count: evidence.length, type: input.type, limit_kind: input.limit_kind ?? "other", third_party: input.third_party ?? null,
        severity: input.severity ?? "medium", status: input.status ?? "open", timing: input.timing ?? null, threshold: input.threshold ?? null,
        impacted_entity_ids: input.impacted_entity_ids ?? [], impacted_users: input.impacted_users ?? [], owner_id: input.owner_id ?? null,
        review_at: input.review_at ?? null, document_ids: input.document_ids ?? [], scaling: input.scaling ?? {}, selected_option_id: null,
        revision: 0, created_at: now(), updated_at: now(),
      };
      if (from) {
        // One write: the strategy lands on the constraint and its "suggested blocker" mark goes.
        const attrs: Record<string, unknown> = { ...(from.attrs ?? {}) };
        delete attrs.proposed_blocker;
        const spec = { type: b.type, limit_kind: b.limit_kind, third_party: b.third_party, severity: b.severity, status: b.status, revision: 1 };
        Object.assign(from, { title: b.statement, body: b.detail, attrs: { ...attrs, blocker: spec }, locked: true, locked_by: ctx.userId, locked_at: now(), updated_at: now() });
      }
      db.blockers.push(b);
      event(ctx, b, "status_changed", b.status, { from_status: null, reason: input.reason ?? "Blocker recorded" });
      b.revision = 1;
      return json(201, { ...strategy(ctx, db, b), evidence });
    }
    const b = p[2] ? find(p[2]) : undefined;
    if (!b) return json(404, { detail: "Blocker not found" });
    if (p.length === 3 && m === "GET") return json(200, strategy(ctx, db, b));
    if (!can(p[3] === "options" ? "commenter" : "approver")) return forbidden(p[3] === "options" ? "commenter" : "approver");
    if (p.length === 3 && m === "PATCH") {
      const patch = await body<Schemas["BlockerPatch"]>();
      if (patch.revision !== b.revision) return json(409, { detail: "Someone else changed this blocker since you loaded it; reload" });
      const before = snapshot(b);
      const after = { ...before, type: patch.type ?? b.type, severity: patch.severity ?? b.severity, document_ids: [...(patch.document_ids ?? b.document_ids)].sort() };
      const unresolved = b.status !== "resolved";
      // B4: removing a document a gating blocker gates takes an owner.
      if (gating(b) && unresolved && before.document_ids.some((d) => !after.document_ids.includes(d)) && !can("owner")) {
        return json(403, { detail: "This blocker gates this document. Only an owner can remove it." });
      }
      // B4: lowering a gating blocker so that it stops gating takes an owner; a resolved one is judged against the gate it had when resolved.
      const floor = unresolved ? undefined : resolveFloor(ctx, b);
      if (((gating(b) && unresolved) || (floor && gating(floor))) && !gating(after) && !can("owner")) {
        return json(403, { detail: "This blocker gates publishing. Only an owner can lower it." });
      }
      // A decision an owner did not make reopens once the blocker gates, unless an owner confirms it (B4).
      const last = [...ctx.v2.blocker_events].reverse().find((e) => e.blocker_id === b.id && e.to_status);
      const byOwner = (last?.data as Record<string, unknown> | undefined)?.by_decider === true;
      const pending = !gating(before) && gating(after) && ["accepted_risk", "feasibility_only"].includes(b.status) && !byOwner;
      const what = b.status === "accepted_risk" ? "risk acceptance" : "feasibility scope";
      if (patch.confirm_decision && !can("owner")) {
        return json(403, { detail: "Only an owner can confirm a risk acceptance or feasibility scope (company setting blocker_risk_acceptance_role)" });
      }
      if (patch.confirm_decision && !pending) {
        return json(409, { detail: "Nothing to confirm: this change reopens no risk acceptance or feasibility scope (confirm_decision applies to a reclassification into critical and hard of a decision the B4 role did not make)" });
      }
      if (pending && !patch.reason?.trim()) {
        return json(422, { detail: `Say why: this reclassification ${patch.confirm_decision ? "keeps" : "reopens"} the blocker's ${what} (reason required)` });
      }
      Object.assign(b, given(patch, ["revision", "reason", "confirm_decision"]));
      b.revision += 1;
      b.updated_at = now();
      let answers: string | undefined;
      if (JSON.stringify(snapshot(b)) !== JSON.stringify(before)) {
        event(ctx, b, "status_changed", null, { from_status: null, reason: patch.reason ?? null, data: { change: "reclassified", before, by_decider: can("owner"), gate: snapshot(b) } });
        answers = ctx.v2.blocker_events[ctx.v2.blocker_events.length - 1].id;
        b.revision -= 1;
      }
      if (pending) {
        if (patch.confirm_decision) {
          event(ctx, b, "status_changed", null, { from_status: null, reason: patch.reason ?? null, data: { change: "confirmed", confirmed: b.status, answers, gate: snapshot(b) } });
        } else {
          const x = b.status === "feasibility_only" ? ctx.v2.feasibility_experiments.find((e) => e.id === last?.experiment_id) : undefined;
          const experiment = x ? { from: x.status, to: ["planned", "running"].includes(x.status) ? "planned" : x.status } : undefined;
          if (x && experiment) x.status = experiment.to as typeof x.status;
          const data = { change: "reopened_by_reclassification", withdrawn: b.status, role: "owner", ...(experiment ? { experiment } : {}), gate: { ...snapshot(b), status: "open" } };
          event(ctx, b, "status_changed", "open", { experiment_id: x?.id ?? null, data, reason: `Reclassified as critical and hard: its ${what} was not decided by an owner, so the blocker is open again until an owner decides` });
        }
      }
      return json(200, strategy(ctx, db, b));
    }
    if (p[3] === "status" && m === "POST") {
      const input = await body<Schemas["BlockerStatusIn"]>();
      if (input.status === "resolved" && !input.reason) return json(422, { detail: "Say why the blocker is resolved" });
      if (input.status !== b.status && b.status === "resolved" && weakens(resolveFloor(ctx, b), snapshot(b)) && !can("owner")) {
        return json(403, { detail: "This blocker gated publishing when it was resolved and was lowered or narrowed since. Only an owner can reopen it." });
      }
      if (input.status !== b.status) {
        const reopened = input.status === "open" && !["open", "mitigating"].includes(b.status);
        event(ctx, b, reopened ? "reopened" : "status_changed", input.status, { reason: input.reason ?? null, data: { gate: { ...snapshot(b), status: input.status } } });
      }
      return json(200, strategy(ctx, db, b));
    }
    if ((p[3] === "accept-risk" || p[3] === "feasibility-scope") && m === "POST" && gating(b) && !can("owner")) {
      const what = p[3] === "accept-risk" ? "accept this risk" : "approve this feasibility scope";
      return json(403, { detail: `Only an owner can ${what} (a critical hard blocker; company setting blocker_risk_acceptance_role)` });
    }
    if (p[3] === "accept-risk" && m === "POST") {
      const input = await body<Schemas["BlockerRiskAcceptanceIn"]>();
      if (!input.reason?.trim() || !input.review_at || new Date(input.review_at) <= new Date()) {
        return json(422, { detail: "Say why, and give a review date in the future" });
      }
      const decision = { id: crypto.randomUUID(), gap_id: null, document_id: b.document_ids[0] ?? null, entity_id: b.id, statement: b.statement, decision: "accept_risk" as const, rationale: input.reason, decided_by: ctx.userId, decided_at: now(), review_at: input.review_at, created_at: now() };
      db.acceptances.push(decision);
      ctx.v2.assumption_decisions.push(decision);
      b.review_at = input.review_at;
      event(ctx, b, "risk_accepted", "accepted_risk", { reason: input.reason, data: { assumption_decision_id: decision.id, by_decider: can("owner") } });
      return json(200, strategy(ctx, db, b));
    }
    if (p[3] === "feasibility-scope" && m === "POST") {
      const input = await body<Schemas["FeasibilityScopeIn"]>();
      const x = ctx.v2.feasibility_experiments.find((e) => e.id === input.experiment_id && e.blocker_id === b.id);
      if (!x) return json(422, { detail: "No such feasibility experiment on this blocker" });
      const missing = [!x.owner_id && "an owner", !x.success_threshold?.trim() && "a success threshold", !x.decision_gate_at && "a decision gate date"].filter(Boolean);
      if (missing.length) return json(422, { detail: `A feasibility scope needs ${missing.join(", ")}` });
      event(ctx, b, "feasibility_scope_approved", "feasibility_only", { reason: input.reason, experiment_id: x.id, data: { by_decider: can("owner") } });
      return json(200, strategy(ctx, db, b));
    }
    if (p[3] === "options" && m === "POST") {
      const input = await body<Schemas["BlockerOptionCreate"]>();
      const f = flags({ title: input.title, description: input.description, details: input.details as Record<string, unknown> });
      const o: Option = {
        id: crypto.randomUUID(), blocker_id: b.id, title: input.title, approach: input.approach, description: input.description ?? null,
        technical_feasibility: input.technical_feasibility ?? "unknown", policy_feasibility: f.length ? "low" : (input.policy_feasibility ?? "unknown"),
        compliance: f.length ? "non_compliant" : "needs_review", status: f.length ? "rejected" : "proposed", details: input.details ?? {},
        evidence_ids: input.evidence_ids ?? [], owner_id: input.owner_id ?? null, selected_reason: null, created_by: ctx.userId, lock_version: 1,
        created_at: now(), updated_at: now(),
      };
      ctx.v2.blocker_options.push(o);
      return json(201, { ...o, policy_flags: f, recommended: false });
    }
    if (p[3] === "experiments" && m === "POST") {
      const input = await body<Schemas["FeasibilityExperimentCreate"]>();
      const x: Experiment = {
        id: crypto.randomUUID(), blocker_id: b.id, option_id: input.option_id ?? null, hypothesis: input.hypothesis, method: input.method ?? null,
        success_threshold: input.success_threshold ?? null, owner_id: input.owner_id ?? null, decision_gate_at: input.decision_gate_at ?? null,
        status: "planned", result: null, evidence_ids: input.evidence_ids ?? [], lock_version: 1, created_at: now(), updated_at: now(),
      };
      ctx.v2.feasibility_experiments.push(x);
      return json(201, x);
    }
    return null;
  }

  if (p[1] === "blocker-options" && p[2] && m !== "GET") {
    const o = ctx.v2.blocker_options.find((x) => x.id === p[2]);
    const b = o ? find(o.blocker_id) : undefined;
    if (!o || !b) return json(404, { detail: "Blocker option not found" });
    if (!can("approver")) return forbidden("approver");
    const input = await body<Schemas["BlockerOptionPatch"]>();
    if (input.lock_version !== o.lock_version) return json(409, { detail: "Someone else changed this since you loaded it; reload and try again" });
    const view = () => json(200, { ...o, policy_flags: flags(o), recommended: false });
    const choosable = (what: string) =>
      o.status === "rejected" || o.compliance !== "compliant" || flags(o).length
        ? json(422, { detail: `Only an option reviewed as compliant can be the ${what}` })
        : null;
    o.lock_version += 1;
    o.updated_at = now();
    if (p.length === 3 && m === "PATCH") {
      if ((o.status === "selected" || o.status === "fallback") && (input.title || input.approach || input.description)) {
        return (o.lock_version -= 1, json(409, { detail: `The ${o.status} option is a decision on this exact text; add another option instead of rewriting it` }));
      }
      const next = { ...o, ...given(input, ["lock_version", "reason"]) } as Option;
      const f = flags(next);
      if (f.length && input.compliance === "compliant") return (o.lock_version -= 1, json(422, { detail: "Flagged text cannot be marked compliant" }));
      Object.assign(o, next, f.length ? { compliance: "non_compliant", status: "rejected", policy_feasibility: "low" } : {});
      return view();
    }
    if (p[3] === "select") {
      const refused = choosable("selected option");
      if (refused) return (o.lock_version -= 1, refused);
      for (const other of ctx.v2.blocker_options) if (other.blocker_id === b.id && other.status === "selected") other.status = "evaluating";
      o.status = "selected";
      o.selected_reason = (input as unknown as Schemas["BlockerOptionDecision"]).reason;
      b.selected_option_id = o.id;
      event(ctx, b, "option_selected", b.status === "open" ? "mitigating" : null, { option_id: o.id, reason: o.selected_reason });
      return json(200, strategy(ctx, db, b));
    }
    if (p[3] === "fallback") {
      const refused = o.status === "selected" ? json(409, { detail: "The selected option cannot also be its own fallback" }) : choosable("fallback");
      if (refused) return (o.lock_version -= 1, refused);
      o.status = "fallback";
      return view();
    }
    if (p[3] === "reject") {
      if (b.selected_option_id === o.id) b.selected_option_id = null;
      o.status = "rejected";
      return view();
    }
    o.lock_version -= 1;
    return null;
  }

  if (p[1] === "feasibility-experiments" && p[2] && m === "PATCH") {
    const x = ctx.v2.feasibility_experiments.find((e) => e.id === p[2]);
    const b = x ? find(x.blocker_id) : undefined;
    if (!x || !b) return json(404, { detail: "Feasibility experiment not found" });
    if (!can("approver")) return forbidden("approver");
    const input = await body<Schemas["FeasibilityExperimentPatch"]>();
    if (input.lock_version !== x.lock_version) return json(409, { detail: "Someone else changed this since you loaded it; reload and try again" });
    const from = x.status;
    Object.assign(x, given(input, ["lock_version"]), { lock_version: x.lock_version + 1, updated_at: now() });
    if (x.status !== from) {
      event(ctx, b, x.status === "running" ? "experiment_started" : "experiment_concluded", null, { experiment_id: x.id });
      if (["failed", "cancelled", "inconclusive"].includes(x.status) && b.status === "feasibility_only") {
        event(ctx, b, "status_changed", "open", { experiment_id: x.id, reason: `The feasibility experiment ${x.status}; its scope no longer holds` });
      }
    }
    return json(200, x);
  }
  return null;
}
