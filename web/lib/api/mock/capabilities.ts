/**
 * GET /v1/me/capabilities in the mock (#370): each operation's role is read off the
 * OpenAPI document's x-min-role, which the API stamps from its own route roles, so the
 * mock keeps no list of its own.
 */
import type { Schemas } from "@/lib/api/client";

type Role = Schemas["Me"]["role"];
type Doc = { paths: Record<string, Record<string, { operationId?: string; "x-min-role"?: Role }>> };

const ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];
let roles: Promise<Record<string, Role>> | null = null;

function operationRoles(): Promise<Record<string, Role>> {
  roles ??= import("../openapi.json").then((m) => {
    const out: Record<string, Role> = {};
    for (const ops of Object.values((m.default as unknown as Doc).paths)) {
      for (const op of Object.values(ops)) if (op.operationId && op["x-min-role"]) out[op.operationId] = op["x-min-role"];
    }
    return out;
  });
  return roles;
}

export async function capabilitiesOut(role: Role, engineeringLead: boolean): Promise<Schemas["Capabilities"]> {
  const operations: Record<string, boolean> = {};
  for (const [op, need] of Object.entries(await operationRoles())) operations[op] = ORDER.indexOf(role) >= ORDER.indexOf(need);
  return { role, engineering_lead: engineeringLead, operations };
}
