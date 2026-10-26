/**
 * Mock of the module catalogue and composition routes (api/oracle/modules/router.py) for
 * NEXT_PUBLIC_API_MOCKS=1. A small synthetic catalogue (a few Pack A core modules and two
 * Pack B conditional ones), the eight packs (the industry packs list only the shared core
 * here), the company module policy, one template manifest, and a confirmed composition
 * for the seeded PRD. A working revision is a draft beside the one in force; a person's
 * earlier add and remove decisions carry into the next revision. Recommendations are canned
 * from the catalogue; the real composer lives in the API. Placeholders only.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type Catalog = Schemas["CatalogModuleDetail"];
type Composed = Schemas["ComposedModule"];
type Revision = Schemas["RevisionDetail"];

export interface ModulesDb {
  catalog: Catalog[];
  policy: Schemas["ModulePolicyOut"];
  manifests: Record<string, Schemas["ManifestOut"]>;
  /** Composition revisions by document id, oldest first. */
  revisions: Record<string, Revision[]>;
}

export interface ModulesContext {
  userId: string;
  role: Role;
  /** Resolves a document id or slug to its id and slug (null: not found, or not a PRD). */
  document: (ref: string) => { id: string; slug: string; template: string | null } | null;
  /** The approved version's id for a document version number, else null. */
  approvedVersion: (documentId: string, n: number) => string | null;
}

const AT = "2026-10-19T09:00:00Z";
const ROLES: Role[] = ["viewer", "commenter", "approver", "owner"];
const PACK_A = "startup.standard";
const PACK_B = "ai-agent.platform";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function atLeast(role: Role, need: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(need);
}

function refused(code: string, message: string, module: string | null = null): Response {
  return json(422, { detail: message, problems: [{ code, message, module, fatal: true }] });
}

function mod(
  key: string,
  title: string,
  policy: Catalog["policy"],
  order: number,
  sections: string[],
  packs: string[],
  depends_on: string[] = [],
): Catalog {
  const contract = { id: key, version: "1.0.0", title, policy, applies_to: packs, depends_on, display_order: order, section_ids: sections };
  return {
    key,
    title,
    description: null,
    builtin: true,
    archived: false,
    version: "1.0.0",
    origin: "builtin",
    policy,
    company_policy: null,
    applies_to: packs,
    depends_on,
    conflicts_with: [],
    section_ids: sections,
    brief_layer: false,
    full_layer: true,
    required_review_role: "approver",
    upgrade_available: null,
    versions: [{ version: "1.0.0", origin: "builtin", contract_hash: "0".repeat(64), created_by: null, created_at: AT }],
    contract,
  };
}

const BOTH = [PACK_A, PACK_B];

export function seedModules(documentId: string | null, userId: string): ModulesDb {
  const catalog: Catalog[] = [
    mod("decision.executive", "Executive decision", "required", 10, ["executive-decision"], BOTH),
    mod("strategy.alignment", "Strategic alignment", "required", 20, ["strategic-alignment"], BOTH),
    mod("goals.outcomes", "Intended outcomes and success metrics", "required", 60, ["outcomes-metrics"], BOTH, ["strategy.alignment"]),
    mod("constraints.solutions", "Constraints, blockers and solution strategy", "required", 100, ["constraints-solutions"], BOTH, ["goals.outcomes"]),
    mod("economics.value", "Value and cost economics", "conditional", 120, ["value-economics"], BOTH, ["goals.outcomes"]),
    mod("risks.register", "Risks", "required", 130, ["risk-register"], BOTH),
    mod("platform.tenant-isolation", "Multi-tenant isolation", "conditional", 210, ["tenant-isolation"], [PACK_B]),
    { ...mod("agents.tool-policies", "Tool policies", "conditional", 240, ["tool-policies"], [PACK_B]), required_review_role: "owner" },
    mod("sources.data-points", "Sources and data points", "required", 1000, ["sources", "sources-list", "sources-data", "sources-evidence"], BOTH),
  ];
  const db: ModulesDb = {
    catalog,
    policy: { required: [], optional: [], disabled: [], default_packs: [], is_default: true, updated_at: null },
    manifests: {
      "oracle-default": {
        template: "oracle-default",
        template_id: "a3000000-0000-4000-8000-000000000001",
        template_version: 2,
        edited: false,
        manifest_format: 1,
        modules: [
          { module_key: "decision.executive", module_version: null, policy: "required", display_order: 10, section_ids: ["summary", "decisions"], sections_present: ["summary", "decisions"], sections_absent: [], created_by: null },
          { module_key: "risks.register", module_version: null, policy: "required", display_order: 130, section_ids: ["top-risks", "risks"], sections_present: ["top-risks", "risks"], sections_absent: [], created_by: null },
          { module_key: "sources.data-points", module_version: null, policy: "required", display_order: 1000, section_ids: ["sources"], sections_present: ["sources"], sections_absent: [], created_by: null },
        ],
        unmapped_sections: ["title", "brief-items", "brief-roadmap", "full", "feature-detail", "milestones"],
      },
    },
    revisions: {},
  };
  if (documentId) {
    const rec = recommend(db, PACK_B, { scope: { capabilities: ["tool_use"] } }, "oracle-default");
    db.revisions[documentId] = [revisionOf(rec, 1, null, userId, "First composition", db)];
  }
  return db;
}

function composed(c: Catalog, included: boolean, selection: Composed["selection"], reason: string, order: number): Composed {
  return {
    key: c.key,
    version: c.version,
    policy: c.policy,
    included,
    reason,
    order,
    section_ids: c.section_ids,
    driven_by: [],
    score: c.policy === "conditional" ? (included ? 1 : 0) : null,
    overridden_by: null,
    title: c.title,
    origin: c.origin,
    selection,
    decided_by: selection === "mandatory" ? "policy" : included ? "condition" : "none",
    policy_source: "pack",
    explanation: [],
    basis: [],
    missing_information: [],
    questions: [],
    depends_on: c.depends_on,
    required_by: [],
    conflicts_with: [],
    layer_impact: {
      brief_sections: [],
      full_sections: c.section_ids,
      new_sections: c.section_ids,
      template_sections: [],
      absent_template_sections: [],
    },
    field_problems: [],
    condition_error: null,
    user_reason: null,
    ordered_by_user: false,
    required_review_role: c.required_review_role,
  };
}

function summary(modules: Composed[]): Schemas["CompositionSummary"] {
  return {
    mandatory: modules.filter((m) => m.selection === "mandatory").length,
    suggested: modules.filter((m) => m.selection === "suggested").length,
    optional: modules.filter((m) => m.selection === "optional").length,
    included: modules.filter((m) => m.included).length,
    excluded: modules.filter((m) => !m.included).length,
  };
}

function inputs(pack: string, extra: Record<string, unknown>, template: string | null): Schemas["CompositionInputs"] {
  return {
    template: { key: template, version: "2" },
    brief: {},
    category: pack === PACK_B ? "ai_agent_platform" : null,
    scope: {},
    signals: {},
    baseline: {},
    sources: {},
    stakeholders: {},
    outputs: [],
    blockers: {},
    policy: { packs: [pack] },
    intake_id: null,
    baseline_snapshot_id: null,
    source_snapshot_ids: [],
    ...extra,
  };
}

/** A canned recommendation: required modules mandatory, Pack B's conditional ones
 * suggested when scope.capabilities names them. */
function recommend(db: ModulesDb, pack: string, extra: Record<string, unknown>, template: string | null): Schemas["RecommendationOut"] {
  const caps = ((extra.scope as { capabilities?: string[] } | undefined)?.capabilities ?? []) as string[];
  const hints: Record<string, string> = { "platform.tenant-isolation": "multi_tenant", "agents.tool-policies": "tool_use", "economics.value": "usage_billing" };
  const modules = db.catalog
    .filter((c) => !c.archived && c.applies_to.includes(pack) && db.policy.disabled.indexOf(c.key) < 0)
    .sort((a, b) => Number(a.contract.display_order) - Number(b.contract.display_order))
    .map((c, i) => {
      if (c.policy === "required" || db.policy.required.includes(c.key)) {
        return composed(c, true, "mandatory", `Mandatory in pack ${pack}.`, (i + 1) * 10);
      }
      const held = caps.includes(hints[c.key] ?? "");
      const out = held
        ? composed(c, true, "suggested", `Suggested: scope.capabilities contains '${hints[c.key]}'`, (i + 1) * 10)
        : composed(c, false, "optional", "Not suggested: its condition did not hold.", 0);
      if (hints[c.key]) {
        out.basis = [
          {
            path: "scope.capabilities",
            op: "contains",
            expected: hints[c.key],
            actual: caps.length ? caps : null,
            holds: held,
            missing: caps.length === 0,
            knowledge_state: caps.length ? "user_decision" : "unknown",
            evidence_ids: [],
            source: caps.length ? "intake" : null,
          },
        ];
        if (!caps.length) {
          out.missing_information = ["Input scope.capabilities is missing."];
          out.questions = [{ key: `${c.key}.capabilities`, prompt: "Which capabilities are in scope?", category: "scope", importance: "high", fills: ["scope.capabilities"] }];
        }
      }
      return out;
    });
  let n = 0;
  for (const m of modules) m.order = m.included ? (n += 10) : 0;
  return {
    document_id: null,
    intake_id: null,
    template,
    template_version: "2",
    packs: [pack],
    valid: true,
    summary: summary(modules),
    modules,
    problems: [],
    outline: outlineOf(modules),
    inputs: inputs(pack, extra, template),
  };
}

/** Carries a person's earlier decisions from `head` and applies `changes`, as the composer
 * does; returns the problems (fatal ones refuse a confirm, a preview reports them). */
function applyChanges(
  db: ModulesDb,
  rec: Schemas["RecommendationOut"],
  head: Revision | null,
  changes: Schemas["ChangesIn"] | null | undefined,
  ctx: ModulesContext,
  reason: string | null,
): Schemas["CompositionProblem"][] {
  const problems: Schemas["CompositionProblem"][] = [];
  const problem = (code: string, message: string, module: string | null) => problems.push({ code, message, module, fatal: true });
  for (const earlier of head?.modules ?? []) {
    const target = rec.modules.find((x) => x.key === earlier.key);
    if (earlier.decided_by !== "user" || !target || target.selection === "mandatory") continue;
    Object.assign(target, { included: earlier.included, decided_by: "user", user_reason: earlier.user_reason, overridden_by: earlier.overridden_by });
  }
  for (const key of changes?.remove ?? []) {
    const target = rec.modules.find((x) => x.key === key);
    // Re-sending an earlier removal refreshes its reason and who decided.
    const again = head?.modules.some((e) => e.key === key && e.decided_by === "user" && !e.included);
    if (!target || (!target.included && !again)) {
      problem("not_included", `${key} is not in the composition.`, key);
      continue;
    }
    if (target.selection === "mandatory") {
      problem("required_module", `${target.title} is mandatory (${target.reason}) and cannot be removed. Change the company module policy to make it optional first.`, key);
      continue;
    }
    if (!atLeast(ctx.role, target.required_review_role as Role)) {
      problem("role_required", `Removing ${target.title} needs the ${target.required_review_role} role.`, key);
      continue;
    }
    Object.assign(target, { included: false, decided_by: "user", user_reason: reason, overridden_by: ctx.userId });
  }
  for (const key of changes?.add ?? []) {
    const target = rec.modules.find((x) => x.key === key);
    if (!target) {
      problem("unknown_module", `${key} is not an available module.`, key);
      continue;
    }
    if (!atLeast(ctx.role, target.required_review_role as Role)) {
      problem("role_required", `Adding ${target.title} needs the ${target.required_review_role} role.`, key);
      continue;
    }
    Object.assign(target, { included: true, decided_by: "user", user_reason: reason, overridden_by: ctx.userId });
  }
  orderModules(db, rec, head, changes, problem);
  rec.summary = summary(rec.modules);
  rec.problems = problems;
  rec.valid = !problems.some((x) => x.fatal);
  rec.outline = outlineOf(rec.modules);
  return problems;
}

/** Step 6 of the composer: the default order (display_order, Sources always last), an
 * earlier person's order carried over, or the order in `changes`. */
function orderModules(
  db: ModulesDb,
  rec: Schemas["RecommendationOut"],
  head: Revision | null,
  changes: Schemas["ChangesIn"] | null | undefined,
  problem: (code: string, message: string, module: string | null) => void,
) {
  const display = (key: string) => Number(db.catalog.find((c) => c.key === key)?.contract.display_order ?? 500);
  const included = rec.modules.filter((m) => m.included);
  const isSources = (key: string) => included.find((m) => m.key === key)?.section_ids.includes("sources") ?? false;
  const defaults = included.map((m) => m.key).sort((a, b) => Number(isSources(a)) - Number(isSources(b)) || display(a) - display(b));
  let order = defaults;
  const wanted = changes?.order;
  if (wanted) {
    const missing = defaults.filter((k) => !wanted.includes(k));
    const extra = wanted.filter((k) => !defaults.includes(k));
    if (missing.length || extra.length || new Set(wanted).size !== wanted.length) {
      problem(
        "order_mismatch",
        "The order must list every included module exactly once" +
          (missing.length ? `; missing ${missing.join(", ")}` : "") +
          (extra.length ? `; not included ${extra.join(", ")}` : "") +
          ".",
        null,
      );
    } else {
      const sources = wanted.filter(isSources);
      const late = sources.filter((s) => wanted.indexOf(s) !== wanted.length - sources.length + sources.indexOf(s));
      for (const s of late) {
        const after = wanted.slice(wanted.indexOf(s) + 1).find((k) => !isSources(k))!;
        problem("order_violation", `${titleOf(rec, after)} must come before ${titleOf(rec, s)}.`, s);
      }
      if (!late.length) order = wanted;
    }
  } else if (head?.modules.some((m) => m.ordered_by_user)) {
    // An earlier person's order over today's modules; new ones follow their default predecessor.
    const prior = [...head.modules].filter((m) => m.included).sort((a, b) => a.order - b.order).map((m) => m.key);
    const out = prior.filter((k) => defaults.includes(k));
    defaults.forEach((key, i) => {
      if (out.includes(key)) return;
      const before = [...defaults.slice(0, i)].reverse().find((k) => out.includes(k));
      out.splice(before ? out.indexOf(before) + 1 : 0, 0, key);
    });
    order = out;
  }
  const byUser = order !== defaults;
  rec.modules.forEach((m) => {
    m.order = m.included ? (order.indexOf(m.key) + 1) * 10 : 0;
    m.ordered_by_user = m.included && byUser;
  });
  rec.modules.sort((a, b) => Number(b.included) - Number(a.included) || a.order - b.order || a.key.localeCompare(b.key));
  rec.outline = outlineOf(rec.modules);
}

function titleOf(rec: Schemas["RecommendationOut"], key: string): string {
  return rec.modules.find((m) => m.key === key)?.title ?? key;
}

function outlineOf(modules: Composed[]): Schemas["OutlineEntry"][] {
  return modules
    .filter((m) => m.included)
    .flatMap((m) => [
      ...m.layer_impact.brief_sections.map((s) => ({ section_id: s, heading: m.title, level: 2, layer: "brief" as const, module: m.key, origin: "module" as const })),
      ...m.section_ids.map((s) => ({ section_id: s, heading: m.title, level: 2, layer: "full" as const, module: m.key, origin: "module" as const })),
    ]);
}

function inspected(m: Composed, db: ModulesDb): Schemas["InspectedModule"] {
  const entry = db.catalog.find((c) => c.key === m.key);
  return { ...m, sections_present: [], sections_missing: [], versions: entry?.versions ?? [], latest_version: entry?.version ?? null, upgrade_available: null };
}

function diffOf(before: Revision | null, after: Composed[]): Schemas["RevisionDiff"] {
  if (!before) return { added: [], removed: [], version_changed: [], reordered: false, material: false, affected_sections: [] };
  const was = new Set(before.modules.filter((m) => m.included).map((m) => m.key));
  const now = new Set(after.filter((m) => m.included).map((m) => m.key));
  const added = [...now].filter((k) => !was.has(k)).sort();
  const removed = [...was].filter((k) => !now.has(k)).sort();
  const affected = [...before.modules, ...after].filter((m) => added.includes(m.key) || removed.includes(m.key)).flatMap((m) => m.section_ids);
  const kept = (ms: Composed[]) =>
    ms
      .filter((m) => m.included && was.has(m.key) && now.has(m.key))
      .sort((a, b) => a.order - b.order)
      .map((m) => m.key)
      .join();
  const reordered = kept(before.modules) !== kept(after);
  return { added, removed, version_changed: [], reordered, material: added.length + removed.length > 0, affected_sections: [...new Set(affected)].sort() };
}

function revisionOf(
  rec: Schemas["RecommendationOut"],
  number: number,
  parent: Revision | null,
  userId: string,
  reason: string,
  db: ModulesDb,
  status: Revision["status"] = "confirmed",
): Revision {
  return {
    id: `a3000000-0000-4000-8000-${String(100 + number).padStart(12, "0")}`,
    number,
    status,
    decided_by: userId,
    decided_at: AT,
    reason,
    parent_number: parent?.number ?? null,
    document_version_id: null,
    diff: diffOf(parent, rec.modules),
    lock_version: 1,
    template: rec.template,
    template_version: rec.template_version,
    packs: rec.packs,
    inputs: rec.inputs,
    modules: rec.modules.map((m) => inspected(m, db)),
    summary: rec.summary,
  };
}

function summaryOf(r: Revision): Schemas["RevisionSummary"] {
  const { id, number, status, decided_by, decided_at, reason, parent_number, document_version_id, diff } = r;
  return { id, number, status, decided_by, decided_at, reason, parent_number, document_version_id, diff };
}

/** The confirmed (or published) revision in force, if any. */
function inForce(revisions: Revision[]): Revision | null {
  return [...revisions].reverse().find((r) => r.status === "confirmed" || r.status === "published") ?? null;
}

function inspector(db: ModulesDb, doc: { id: string; slug: string; template: string | null }): Schemas["InspectorOut"] {
  const revisions = db.revisions[doc.id] ?? [];
  const head = revisions[revisions.length - 1] ?? null;
  const current = inForce(revisions);
  return {
    document_id: doc.id,
    slug: doc.slug,
    legacy: current === null,
    composition_id: head ? "a3000000-0000-4000-8000-000000000002" : null,
    lock_version: head ? revisions.length : null,
    head_revision: head?.number ?? null,
    current,
    working: head?.status === "working" ? head : null,
    recommendation: current ? null : { ...recommend(db, PACK_A, {}, doc.template), document_id: doc.id },
    revisions: [...revisions].reverse().map(summaryOf),
    sections: { version: null, unmapped: [] },
    problems: [],
  };
}

function compositionOut(r: Revision, documentId: string): Schemas["CompositionRevisionOut"] {
  return {
    id: r.id,
    composition_id: "a3000000-0000-4000-8000-000000000002",
    number: r.number,
    status: r.status,
    modules: r.modules,
    inputs: r.inputs,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    reason: r.reason,
    parent_number: r.parent_number,
    document_version_id: r.document_version_id ?? documentId,
    lock_version: r.lock_version,
    created_at: AT,
  };
}

/** The module and composition routes; null when the path is not one of them. */
export async function routeModules(db: ModulesDb, ctx: ModulesContext, req: Request, p: string[], q: URLSearchParams): Promise<Response | null> {
  const m = req.method;
  const body = async <T>() => JSON.parse((await req.text()) || "null") as T;
  const forbidden = (need: Role) => json(403, { detail: `Requires the ${need} role` });

  if (p[1] === "module-catalog") {
    if (m === "GET" && !p[2]) {
      const pack = q.get("pack");
      const listed = db.catalog.filter((c) => !pack || c.applies_to.includes(pack));
      return json(
        200,
        listed.map((c) => {
          const out: Partial<Catalog> = { ...c };
          delete out.contract;
          return out;
        }),
      );
    }
    if (m === "GET" && p[2] && !p[3]) {
      const entry = db.catalog.find((c) => c.key === p[2]);
      return entry ? json(200, entry) : json(404, { detail: `module ${p[2]} not found` });
    }
    if (m === "POST") {
      if (!atLeast(ctx.role, "owner")) return forbidden("owner");
      const { contract } = await body<Schemas["ModuleContractIn"]>();
      const key = String(contract.id ?? "");
      if (!p[2]) {
        if (db.catalog.some((c) => c.key === key)) return refused("key_taken", `module ${key} already exists`);
        const created = { ...mod(key, String(contract.title ?? key), (contract.policy as Catalog["policy"]) ?? "optional", 100, [key.replace(/\./g, "-")], (contract.applies_to as string[]) ?? []), builtin: false, origin: "company" as const, contract };
        db.catalog.push(created);
        return json(201, created);
      }
      const entry = db.catalog.find((c) => c.key === p[2]);
      if (!entry) return json(404, { detail: `module ${p[2]} not found` });
      const version = String(contract.version ?? "");
      if (entry.versions.some((v) => v.version >= version)) return refused("version_not_newer", `version ${version} must be newer than ${entry.version}`);
      entry.versions.push({ version, origin: "company", contract_hash: "1".repeat(64), created_by: ctx.userId, created_at: new Date().toISOString() });
      Object.assign(entry, { version, origin: "company", contract });
      return json(201, entry);
    }
  }

  if (p[1] === "module-packs" && m === "GET") {
    const packs: [string, string, string[]][] = [
      [PACK_A, "General Tech Startup", []],
      [PACK_B, "Multi-tenant AI Agent Platform", ["ai_agent_platform"]],
      ["marketplace.ecommerce", "Marketplace and e-commerce", ["marketplace", "ecommerce"]],
      ["fintech.payments", "Fintech and payments", ["fintech", "payments"]],
      ["hardware.iot", "Hardware and IoT", ["hardware", "iot"]],
      ["saas.b2b", "SaaS and B2B products", ["saas", "b2b_saas"]],
      ["smb.services", "SMB services", ["smb_services"]],
      ["enterprise.software", "Enterprise software", ["enterprise_software"]],
    ];
    return json(
      200,
      packs.map(([id, title, categories]) => ({
        id,
        version: "1.0.0",
        title,
        description: "Template only: modules, instructions and questions; no prewritten content.",
        categories,
        // Industry packs reuse the shared core (Pack A) in the mock.
        modules: db.catalog
          .filter((c) => c.applies_to.includes(id === PACK_B ? PACK_B : PACK_A))
          .map((c) => ({ key: c.key, title: c.title, policy: c.policy })),
      })),
    );
  }

  if (p[1] === "module-policy") {
    if (m === "GET") return json(200, db.policy);
    if (m === "PUT") {
      if (!atLeast(ctx.role, "owner")) return forbidden("owner");
      const next = await body<Schemas["ModulePolicySettings"]>();
      const unknown = [...(next.required ?? []), ...(next.optional ?? []), ...(next.disabled ?? [])].filter((k) => !db.catalog.some((c) => c.key === k));
      if (unknown.length) return refused("unknown_module", `unknown modules: ${unknown.join(", ")}`);
      db.policy = { required: next.required ?? [], optional: next.optional ?? [], disabled: next.disabled ?? [], default_packs: next.default_packs ?? [], is_default: false, updated_at: new Date().toISOString() };
      return json(200, db.policy);
    }
  }

  if (p[1] === "template-manifests" && p[2]) {
    const manifest = db.manifests[p[2]];
    if (m === "GET") return manifest ? json(200, manifest) : json(404, { detail: `template '${p[2]}' not found` });
    if (m === "PUT") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      if (!manifest) return json(404, { detail: `template '${p[2]}' not found` });
      const { modules } = await body<Schemas["ManifestIn"]>();
      manifest.edited = true;
      manifest.modules = modules.map((x) => ({
        module_key: x.module_key,
        module_version: x.module_version ?? null,
        policy: x.policy,
        display_order: x.display_order ?? 100,
        section_ids: x.section_ids ?? [],
        sections_present: x.section_ids ?? [],
        sections_absent: [],
        created_by: ctx.userId,
      }));
      return json(200, manifest);
    }
  }

  if (p[1] === "compositions" && p[2] === "recommend" && m === "POST") {
    const data = await body<Schemas["CompositionRecommendIn"]>();
    const doc = data.document ? ctx.document(data.document) : null;
    if (data.document && !doc) return json(404, { detail: `document '${data.document}' not found` });
    // For a document, the newest revision's packs, inputs and decisions are the starting point.
    const revisions = doc ? (db.revisions[doc.id] ?? []) : [];
    const head = revisions[revisions.length - 1] ?? null;
    const pack = data.packs?.[0] ?? head?.packs[0] ?? (data.inputs?.category === "ai_agent_platform" ? PACK_B : PACK_A);
    const extra = data.inputs && Object.keys(data.inputs).length ? data.inputs : head ? { scope: head.inputs.scope } : {};
    const rec = { ...recommend(db, pack, extra, data.template ?? doc?.template ?? "oracle-default"), document_id: doc?.id ?? null };
    applyChanges(db, rec, head, data.changes, ctx, null);
    return json(200, rec);
  }

  if (p[1] === "documents" && p[2] && p[3] === "composition") {
    const doc = ctx.document(p[2]);
    if (!doc) return json(404, { detail: `document '${p[2]}' not found` });
    const revisions = (db.revisions[doc.id] ??= []);
    const head = revisions[revisions.length - 1] ?? null;
    const current = inForce(revisions);
    if (m === "GET" && !p[4]) return json(200, inspector(db, doc));
    if (m === "POST" && p[4] === "revisions") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      const data = await body<Schemas["RevisionIn"]>();
      if ((data.base_revision ?? null) !== (head?.number ?? null)) {
        return json(409, { detail: "Someone else changed this since you loaded it; reload and try again" });
      }
      // Only a pack a person chose carries; a default or category pack is recomputed.
      const carried = head?.inputs.policy?.packs_source === "chosen" ? head.packs[0] : undefined;
      const category = data.inputs?.category ?? head?.inputs.category;
      const pack = data.packs?.[0] ?? carried ?? db.policy.default_packs[0] ?? (category === "ai_agent_platform" ? PACK_B : PACK_A);
      const packsSource = data.packs?.length || carried ? "chosen" : db.policy.default_packs.length ? "default" : "category";
      // Inputs not given are derived from the newest revision.
      const extra = data.inputs && Object.keys(data.inputs).length ? data.inputs : head ? { scope: head.inputs.scope } : {};
      const rec = recommend(db, pack, extra, data.template ?? doc.template ?? "oracle-default");
      rec.inputs.policy = { ...rec.inputs.policy, packs_source: packsSource };
      const problems = applyChanges(db, rec, head, data.changes, ctx, data.reason);
      const fatal = problems.filter((x) => x.fatal);
      if (fatal.length) return json(422, { detail: fatal[0].message, problems: fatal });
      rec.summary = summary(rec.modules);
      const status = data.status ?? "confirmed";
      if (status === "confirmed") {
        // Confirming supersedes the revision in force and any drafts; a working save
        // supersedes nothing.
        for (const r of revisions) if (r.status === "confirmed" || r.status === "working") r.status = "superseded";
      }
      revisions.push(revisionOf(rec, revisions.length + 1, status === "confirmed" ? current : head, ctx.userId, data.reason, db, status));
      return json(201, inspector(db, doc));
    }
    if (m === "POST" && p[4] === "publish") {
      if (!atLeast(ctx.role, "approver")) return forbidden("approver");
      const { version } = await body<Schemas["PublishIn"]>();
      if (!current) return json(409, { detail: "the document has no composition to publish; confirm one first" });
      if (current.status !== "confirmed" && current.status !== "published") {
        return json(409, { detail: `composition revision ${current.number} is ${current.status}, not confirmed` });
      }
      const versionId = ctx.approvedVersion(doc.id, version);
      if (!versionId) return json(409, { detail: `version ${version} is not approved; approve it before publishing` });
      current.status = "published";
      current.document_version_id = versionId;
      return json(200, compositionOut(current, versionId));
    }
  }
  return null;
}
