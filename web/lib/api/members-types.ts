/**
 * A5 Members and access (#203 part 2): the member detail, the preview of a removal or a
 * demotion, and hand-over. Hand-written until the schema is regenerated from the API
 * (api/oracle/members); the shapes mirror it. Calls go through the same client (and so
 * through the mock in mock mode), untyped by path.
 */
import { api, ApiError, unwrap, type Member, type Schemas } from "@/lib/api/client";

export type Role = Schemas["MemberOut"]["role"];

export type Held = { ref: string; title: string };

export type ResponsibilityKind =
  | "review_decider"
  | "mandatory_reviewer"
  | "section_owner"
  | "section_reviewer"
  | "questions"
  | "open_items";

export type Responsibility = {
  kind: ResponsibilityKind | string;
  label: string;
  count: number;
  items: Held[];
  needs_role: Role;
  blocks: string | null;
  /** In a role preview: false when the new role is below needs_role. */
  holder_ok?: boolean;
};

export type Joined = {
  at: string | null;
  via: "invite" | "access_request" | "domain" | "seeded" | "unknown";
  by: string | null;
  by_name: string | null;
};

export type Holds = { section_approvals: number; version_approvals: number; spend_approvals: number; checkpoint_decisions: number };

export type MemberDetail = Member & { joined: Joined; responsibilities: Responsibility[]; holds: Holds };

export type Impact = {
  member_id: string;
  change: "remove" | "role";
  role: Role | null;
  as_of: string;
  ends: {
    sign_in: boolean;
    api_tokens: number;
    mcp_clients: number;
    connections: Record<string, number>;
    sources: number;
    runs: { id: string; title: string; status: string }[];
    llm_jobs: number;
    invites: number;
  } | null;
  voids: {
    spend_approvals: { run_id: string; title: string }[];
    resumes: { run_id: string; title: string }[];
    checkpoint_decisions: { run_id: string; checkpoint_id: string; kind: string; title: string }[];
  };
  lapses: { section_approvals: number; version_approvals: { document: string; title: string; version: number }[] };
  responsibilities: Responsibility[];
  nothing: boolean;
};

export type HandOver = { kind: string; to: string | null };

type Loose = (path: string, init?: { params?: object; body?: unknown }) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
const loose = api as unknown as { GET: Loose; POST: Loose; PATCH: Loose };

/** unwrap, plus the hand-over refusal's list ({"detail": [{"code", "kind", "message"}]}) as one message. */
async function call<T>(p: ReturnType<Loose>): Promise<T> {
  const r = await p;
  const detail = r.error && typeof r.error === "object" && "detail" in r.error ? (r.error as { detail: unknown }).detail : null;
  if (!r.response.ok && Array.isArray(detail)) {
    const said = detail.map((d) => (d && typeof d === "object" && "message" in d ? String(d.message) : "")).filter(Boolean);
    const code = detail[0] && typeof detail[0] === "object" && "code" in detail[0] ? String(detail[0].code) : undefined;
    throw new ApiError(r.response.status, said.join("; ") || r.response.statusText, code);
  }
  return unwrap(p as Promise<{ data?: T; error?: unknown; response: Response }>);
}

const path = (id: string) => ({ path: { user_id: id } });

export const membersApi = {
  detail: (id: string) => call<MemberDetail>(loose.GET("/v1/members/{user_id}", { params: path(id) })),
  impact: (id: string, change: "remove" | { role: Role }) =>
    call<Impact>(
      loose.GET("/v1/members/{user_id}/impact", {
        params: { ...path(id), query: change === "remove" ? { change } : { change: "role", role: change.role } },
      }),
    ),
  disable: (id: string, hand_over: HandOver[]) =>
    call<Member>(loose.POST("/v1/members/{user_id}/disable", { params: path(id), body: hand_over.length ? { hand_over } : undefined })),
  patch: (id: string, body: { role?: Role; name?: string | null; hand_over?: HandOver[] }) =>
    call<Member>(loose.PATCH("/v1/members/{user_id}", { params: path(id), body })),
  /** #203 part 3: their live section verdicts and version approvals. */
  approvals: (id: string) => call<Schemas["TokenApprovalOut"][]>(loose.GET("/v1/members/{user_id}/approvals", { params: path(id) })),
  handOver: (id: string, hand_over: HandOver[]) =>
    call<{ responsibilities: Responsibility[] }>(loose.POST("/v1/members/{user_id}/hand-over", { params: path(id), body: { hand_over } })),
};

const ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
/** As has_role: `role` is `need` or above. */
export const hasRole = (role: Role, need: Role) => ORDER.indexOf(role) >= ORDER.indexOf(need);
