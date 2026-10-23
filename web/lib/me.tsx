"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, type Me, type Schemas } from "@/lib/api/client";
import type { operations } from "@/lib/api/schema";

export type Role = Me["role"];
/** An API operation (its operationId), as GET /v1/me/capabilities names it. */
export type Operation = keyof operations;

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
  /**
   * #370: whether the signed-in role may call `op` (GET /v1/me/capabilities, derived from
   * the API's own route roles). False until the capabilities have loaded.
   */
  can: (op: Operation) => boolean;
  /** True once the capabilities of the signed-in principal have loaded. */
  capsReady: boolean;
  /** Re-reads GET /v1/me. */
  refresh: () => Promise<void>;
  /** Forgets the principal locally (after sign-out). */
  clear: () => void;
};

const MeContext = createContext<MeState | null>(null);

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

  // Read once per signed-in principal and role: a new sign-in or a role change reloads them.
  const capsKey = state.me ? `${state.me.user_id ?? state.me.token_id}|${state.me.role}|${state.me.engineering_lead}` : null;
  const [caps, setCaps] = useState<{ key: string; caps: Schemas["Capabilities"] } | null>(null);
  useEffect(() => {
    if (!capsKey) return;
    let alive = true;
    api
      .GET("/v1/me/capabilities")
      .then((res) => alive && res.data && setCaps({ key: capsKey, caps: res.data }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [capsKey]);
  const ops = caps && caps.key === capsKey ? caps.caps.operations : null;
  const can = useCallback((op: Operation) => ops?.[op] === true, [ops]);

  const value = useMemo<MeState>(
    () => ({
      me: state.me,
      role: state.me?.role ?? null,
      engineeringLead: state.me?.engineering_lead ?? false,
      loading: state.loading,
      can,
      capsReady: ops !== null,
      refresh,
      clear,
    }),
    [state, refresh, clear, can, ops],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
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
