/**
 * A5 Members and access in the mock (#203 part 2): a member's detail, the preview of a
 * removal or a demotion (GET /v1/members/{id}/impact), and hand-over, with the API's rules
 * (api/oracle/members/handover.py): a target is an active member other than the subject
 * with at least the kind's role; `to: null` clears; a kind left out stays; any refusal is
 * 422 `hand_over_target` and nothing moves.
 *
 * What a member holds lives here, seeded per 3.11: approver@example.com decides the company
 * review policy, owns 2 sections, has 1 open question and holds 3 section approvals, 1 version
 * approval and 1 undelivered checkpoint decision; the removed former.pm@example.com still owns
 * 2 sections and decides one document policy.
 */
import type { Schemas } from "@/lib/api/client";
import type { HandOver, Held, Impact, Responsibility } from "@/lib/api/members-types";

type MemberRow = Schemas["MemberOut"];
type Role = MemberRow["role"];

const ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
const hasRole = (role: Role, need: Role) => ORDER.indexOf(role) >= ORDER.indexOf(need);
const ROLE_WORD: Record<Role, string> = { viewer: "viewer", commenter: "commenter", approver: "approver", owner: "owner" };

/** The kinds A5 registers: label, the role a holder needs, what waits while nobody holds it. */
export const KINDS: { kind: string; label: string; needs_role: Role; blocks: string | null; verb: string }[] = [
  { kind: "review_decider", label: "Decides document reviews", needs_role: "approver", blocks: "Publishing waits until someone else decides", verb: "decide document reviews" },
  { kind: "mandatory_reviewer", label: "Must approve document reviews", needs_role: "approver", blocks: "Publishing waits for this approval", verb: "approve document reviews" },
  { kind: "section_owner", label: "Owns document sections", needs_role: "commenter", blocks: null, verb: "own document sections" },
  { kind: "section_reviewer", label: "Reviews document sections", needs_role: "commenter", blocks: null, verb: "review document sections" },
  { kind: "questions", label: "Has open questions to answer", needs_role: "commenter", blocks: null, verb: "answer questions" },
  { kind: "open_items", label: "Owns open items", needs_role: "viewer", blocks: null, verb: "own open items" },
];

/** What one member holds, as the mock knows it. */
export type Holding = {
  held: Record<string, Held[]>;
  section_approvals: number;
  version_approvals: { document: string; title: string; version: number }[];
  checkpoint_decisions: { run_id: string; checkpoint_id: string; kind: string; title: string }[];
  spend_approvals: { run_id: string; title: string }[];
};

export type MembersDb = {
  members: MemberRow[];
  invites: Schemas["InviteOut"][];
  holdings?: Record<string, Holding>;
};

export type MembersContext = {
  db: MembersDb;
  me: MemberRow;
  uuid: () => string;
  now: () => string;
  openTokens: (userId: string) => number;
  /** Live personal API tokens and MCP clients, apart. */
  credentials: (userId: string) => { api_tokens: number; mcp_clients: number };
};

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const empty = (): Holding => ({ held: {}, section_approvals: 0, version_approvals: [], checkpoint_decisions: [], spend_approvals: [] });

/** The seeded holdings (3.11), made once per mock db. */
function holdings(ctx: MembersContext): Record<string, Holding> {
  if (ctx.db.holdings) return ctx.db.holdings;
  const out: Record<string, Holding> = {};
  const approver = ctx.db.members.find((m) => m.email === "approver@example.com");
  if (approver) {
    out[approver.id] = {
      held: {
        review_decider: [{ ref: "review_policy:company", title: "Company review policy" }],
        section_owner: [
          { ref: "section:usage-alerts#problem", title: "Usage alerts · Problem" },
          { ref: "section:usage-alerts#goals", title: "Usage alerts · Goals" },
        ],
        questions: [{ ref: "question:q-pricing", title: "Which plans get alerts first?" }],
      },
      section_approvals: 3,
      version_approvals: [{ document: "usage-alerts", title: "Usage alerts", version: 4 }],
      checkpoint_decisions: [{ run_id: "run-mock-feature-set", checkpoint_id: "cp-mock-feature-set", kind: "feature_set", title: "Baseline to PRD · Usage alerts" }],
      spend_approvals: [],
    };
  }
  const former = ctx.db.members.find((m) => m.email === "former.pm@example.com");
  if (former) {
    out[former.id] = {
      ...empty(),
      held: {
        review_decider: [{ ref: "document:fleet-tracking", title: "Fleet tracking" }],
        section_owner: [
          { ref: "section:fleet-tracking#scope", title: "Fleet tracking · Scope" },
          { ref: "section:fleet-tracking#rollout", title: "Fleet tracking · Rollout" },
        ],
      },
    };
  }
  return (ctx.db.holdings = out);
}

const holdingOf = (ctx: MembersContext, id: string) => (holdings(ctx)[id] ??= empty());

/** The member's open responsibilities, one per kind held; `role` marks holder_ok against it. */
function responsibilities(ctx: MembersContext, id: string, role?: Role): Responsibility[] {
  const h = holdingOf(ctx, id);
  return KINDS.filter((k) => h.held[k.kind]?.length).map((k) => ({
    kind: k.kind,
    label: k.label,
    count: h.held[k.kind].length,
    items: h.held[k.kind],
    needs_role: k.needs_role,
    blocks: k.blocks,
    ...(role ? { holder_ok: hasRole(role, k.needs_role) } : {}),
  }));
}

const nameOf = (m: MemberRow | undefined) => (m ? m.name || m.email : null);

/** As handover.hand_over: every move is checked before any applies; a refusal moves nothing. */
export function handOver(ctx: MembersContext, fromId: string, moves: HandOver[] | null | undefined): Response | null {
  if (!moves?.length) return null;
  const refused: { code: string; kind: string; message: string }[] = [];
  for (const move of moves) {
    const k = KINDS.find((x) => x.kind === move.kind);
    if (!k) {
      refused.push({ code: "hand_over_target", kind: move.kind, message: `Unknown responsibility ${move.kind}` });
      continue;
    }
    if (move.to == null) continue;
    const to = ctx.db.members.find((m) => m.id === move.to);
    if (!to || to.status === "disabled" || to.id === fromId) {
      refused.push({ code: "hand_over_target", kind: move.kind, message: `Hand ${k.label.toLowerCase()} to an active member other than them` });
    } else if (!hasRole(to.role, k.needs_role)) {
      refused.push({ code: "hand_over_target", kind: move.kind, message: `${to.email} needs the ${ROLE_WORD[k.needs_role]} role to ${k.verb}` });
    }
  }
  if (refused.length) return json(422, { detail: refused });
  const from = holdingOf(ctx, fromId);
  for (const move of moves) {
    const items = from.held[move.kind] ?? [];
    if (move.to) {
      const into = holdingOf(ctx, move.to);
      const have = new Set((into.held[move.kind] ?? []).map((x) => x.ref));
      into.held[move.kind] = [...(into.held[move.kind] ?? []), ...items.filter((x) => !have.has(x.ref))];
    }
    delete from.held[move.kind];
  }
  return null;
}

/** What a removal or a demotion ends, voids and lapses, read only (the API's selections). */
export function impact(ctx: MembersContext, target: MemberRow, change: "remove" | "role", role: Role | null): Impact {
  const h = holdingOf(ctx, target.id);
  const base = { member_id: target.id, change, role, as_of: ctx.now() };
  const none: Impact = {
    ...base,
    ends: null,
    voids: { spend_approvals: [], resumes: [], checkpoint_decisions: [] },
    lapses: { section_approvals: 0, version_approvals: [] },
    responsibilities: [],
    nothing: true,
  };
  if (change === "remove") {
    if (target.status === "disabled") return none;
    const out: Impact = {
      ...base,
      ends: {
        sign_in: true,
        api_tokens: ctx.credentials(target.id).api_tokens,
        mcp_clients: ctx.credentials(target.id).mcp_clients,
        connections: {},
        sources: 0,
        runs: [],
        llm_jobs: 0,
        invites: ctx.db.invites.filter((i) => i.invited_by === target.id && i.status === "open").length,
      },
      voids: { spend_approvals: h.spend_approvals, resumes: [], checkpoint_decisions: h.checkpoint_decisions },
      lapses: { section_approvals: h.section_approvals, version_approvals: h.version_approvals },
      responsibilities: responsibilities(ctx, target.id),
      nothing: false,
    };
    return out;
  }
  // A promotion, or the member's own role, touches nothing.
  if (!role || hasRole(role, target.role)) return none;
  // set_role: below approver their section and version approvals lapse and their checkpoint
  // decisions go back to the Inbox; below commenter the same.
  const losesApproval = hasRole(target.role, "approver") && !hasRole(role, "approver");
  const held = responsibilities(ctx, target.id, role);
  const out: Impact = {
    ...base,
    voids: { spend_approvals: [], resumes: [], checkpoint_decisions: losesApproval ? h.checkpoint_decisions : [] },
    lapses: losesApproval ? { section_approvals: h.section_approvals, version_approvals: h.version_approvals } : { section_approvals: 0, version_approvals: [] },
    responsibilities: held,
    ends: null,
    nothing: false,
  };
  out.nothing = !out.voids.checkpoint_decisions.length && !out.lapses.section_approvals && !out.lapses.version_approvals.length && held.every((r) => r.holder_ok);
  return out;
}

/** After a disable or a demotion: what they no longer hold (lapsed approvals, voided decisions). */
export function applied(ctx: MembersContext, target: MemberRow, change: "remove" | "role") {
  const h = holdingOf(ctx, target.id);
  if (change === "remove" || !hasRole(target.role, "approver")) {
    Object.assign(h, { section_approvals: 0, version_approvals: [], checkpoint_decisions: [], spend_approvals: [] });
  }
}

/**
 * The A5 member routes membersRoute hands here (owner only, checked there): GET
 * /v1/members/{id}, …/impact, …/approvals and POST …/hand-over. Null for anything else.
 */
export async function membersDetailRoute(ctx: MembersContext, req: Request, p: string[]): Promise<Response | null> {
  if (p[1] !== "members" || !p[2]) return null;
  const target = ctx.db.members.find((x) => x.id === p[2]);
  if (!target) return null;
  const m = req.method;
  const url = new URL(req.url);
  if (m === "GET" && !p[3]) {
    const h = holdingOf(ctx, target.id);
    const inviter = ctx.db.invites.find((i) => i.email === target.email && i.status === "accepted");
    const by = inviter ? ctx.db.members.find((x) => x.id === inviter.invited_by) : undefined;
    return json(200, {
      ...target,
      open_tokens: ctx.openTokens(target.id),
      joined: inviter
        ? { at: inviter.accepted_at ?? target.created_at, via: "invite", by: by?.id ?? null, by_name: nameOf(by) }
        : { at: target.created_at, via: "seeded", by: null, by_name: null },
      responsibilities: responsibilities(ctx, target.id),
      holds: {
        section_approvals: h.section_approvals,
        version_approvals: h.version_approvals.length,
        spend_approvals: h.spend_approvals.length,
        checkpoint_decisions: h.checkpoint_decisions.length,
      },
    });
  }
  if (m === "GET" && p[3] === "impact") {
    const change = url.searchParams.get("change");
    const role = url.searchParams.get("role") as Role | null;
    if (change !== "remove" && change !== "role") return json(422, { detail: "change is remove or role" });
    if (change === "role" && (!role || !ORDER.includes(role))) return json(422, { detail: "role is viewer, commenter, approver or owner" });
    return json(200, impact(ctx, target, change, change === "role" ? role : null));
  }
  if (m === "GET" && p[3] === "approvals") return json(200, []);
  if (m === "POST" && p[3] === "hand-over") {
    const input = JSON.parse((await req.text()) || "null") as { hand_over?: HandOver[] } | null;
    const refused = handOver(ctx, target.id, input?.hand_over ?? []);
    if (refused) return refused;
    return json(200, { responsibilities: responsibilities(ctx, target.id) });
  }
  return null;
}
