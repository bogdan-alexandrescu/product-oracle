"use client";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type Role = Schemas["Me"]["role"];

/** B4 defaults (api/oracle/tenant_settings_api.py), used when the caller cannot read the settings. */
export const RISK_DEFAULTS = { role: "owner" as Role, maxDays: 90 };

/**
 * The company's B4 settings: who may accept a critical blocker's risk (or approve its
 * feasibility scope), and how far out its review date may be. Settings are
 * owner-readable; anyone else gets the defaults.
 */
export function useRiskPolicy(): { role: Role; maxDays: number } {
  const { role } = useMe();
  const q = useQuery(`risk-policy|${role}`, async () => {
    if (!hasRole(role, "approver")) return RISK_DEFAULTS;
    const read = (key: string) => unwrap(api.GET("/v1/settings/{key}", { params: { path: { key } } })).then((s) => s.value);
    const [who, days] = await Promise.all([read("blocker_risk_acceptance_role"), read("blocker_risk_review_max_days")]).catch(() => [null, null]);
    return {
      role: who === "approver" || who === "owner" ? (who as Role) : RISK_DEFAULTS.role,
      maxDays: typeof days === "number" && days >= 1 ? days : RISK_DEFAULTS.maxDays,
    };
  });
  return q.data ?? RISK_DEFAULTS;
}
