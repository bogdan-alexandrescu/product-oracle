/**
 * GET /v1/me/capabilities in the mock (#370): each operation's role is read off the
 * OpenAPI document's x-min-role, which the API stamps from its own route roles, so the
 * mock keeps no list of its own.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type Op = { operationId?: string; "x-min-role"?: Role; "x-lead-role"?: Role; "x-per-item"?: Role | null };
type Doc = { paths: Record<string, Record<string, Op>> };
type Roles = { min: Record<string, Role>; lead: Record<string, Role>; perItem: Record<string, Role | null> };

const ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
const at = (role: Role, need: Role) => ORDER.indexOf(role) >= ORDER.indexOf(need);
let roles: Promise<Roles> | null = null;

function operationRoles(): Promise<Roles> {
  roles ??= import("../openapi.json").then((m) => {
    const out: Roles = { min: {}, lead: {}, perItem: {} };
    for (const ops of Object.values((m.default as unknown as Doc).paths)) {
      for (const op of Object.values(ops)) {
        if (!op.operationId) continue;
        if (op["x-min-role"]) out.min[op.operationId] = op["x-min-role"];
        if (op["x-lead-role"]) out.lead[op.operationId] = op["x-lead-role"];
        if (op["x-per-item"] !== undefined) out.perItem[op.operationId] = op["x-per-item"];
      }
    }
    return out;
  });
  return roles;
}

/**
 * `leadNamed`: whether the company has an engineering lead; the engineering stops then go to
 * the leads and owners (A3), and with none named to the stop's role (approver).
 */
export async function capabilitiesOut(role: Role, engineeringLead: boolean, leadNamed = engineeringLead): Promise<Schemas["Capabilities"]> {
  const { min, lead, perItem } = await operationRoles();
  const operations: Record<string, boolean> = {};
  for (const [op, need] of Object.entries(min)) operations[op] = at(role, need) || (engineeringLead && op in lead && at(role, lead[op]));
  const decide_engineering_stops = leadNamed ? role === "owner" || (engineeringLead && at(role, "commenter")) : at(role, "approver");
  return { role, engineering_lead: engineeringLead, operations, decide_engineering_stops, per_item: perItem };
}
