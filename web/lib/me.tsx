"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, type Me } from "@/lib/api/client";
import { DEFAULT_ZONE, setDisplayZone } from "@/lib/zone";

export type Role = Me["role"];

const ROLE_ORDER: readonly Role[] = ["viewer", "commenter", "approver", "owner"];

/** True when `role` is at least `min` (viewer < commenter < approver < owner). */
export function hasRole(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

type MeState = {
  /** The signed-in principal, or null when signed out (or not loaded yet). */
  me: Me | null;
  role: Role | null;
  /** A3: the signed-in principal acts for an engineering lead. */
  engineeringLead: boolean;
  /** True until the first GET /v1/me has answered. */
  loading: boolean;
  /** Re-reads GET /v1/me. */
  refresh: () => Promise<void>;
  /** Forgets the principal locally (after sign-out). */
  clear: () => void;
};

const MeContext = createContext<MeState | null>(null);

/**
 * The Company time zone (#447). useQuery reads it, so a screen showing loaded data draws
 * its dates again when GET /v1/me answers with a zone other than the default.
 */
export const CompanyZoneContext = createContext<string>(DEFAULT_ZONE);

/**
 * Loads GET /v1/me for the whole app. Pair it with <MeSync /> (inside a Suspense
 * boundary) to re-check on every navigation, so sign-in and sign-out show up.
 */
export function MeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ me: Me | null; loading: boolean }>({ me: null, loading: true });
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const call = ++seq.current;
    const res = await api.GET("/v1/me").catch(() => undefined);
    // Only the latest call wins, so a slow answer never overwrites a newer one.
    if (call !== seq.current) return;
    setState({ me: res?.response.ok ? (res.data ?? null) : null, loading: false });
  }, []);

  const clear = useCallback(() => {
    seq.current += 1;
    setState({ me: null, loading: false });
  }, []);

  const value = useMemo<MeState>(
    () => ({
      me: state.me,
      role: state.me?.role ?? null,
      engineeringLead: state.me?.engineering_lead ?? false,
      loading: state.loading,
      refresh,
      clear,
    }),
    [state, refresh, clear],
  );
  const zone = state.me?.company_timezone || DEFAULT_ZONE;
  // Before the children render, so lib/format.ts formats in this zone.
  setDisplayZone(zone);
  return (
    <MeContext.Provider value={value}>
      <CompanyZoneContext.Provider value={zone}>{children}</CompanyZoneContext.Provider>
    </MeContext.Provider>
  );
}

/** Re-checks GET /v1/me whenever the pathname changes. Render it inside <Suspense>. */
export function MeSync() {
  const pathname = usePathname();
  const { refresh } = useMe();
  useEffect(() => {
    void refresh();
  }, [pathname, refresh]);
  return null;
}

export function useMe(): MeState {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe() must be used inside <MeProvider>");
  return ctx;
}
