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
   * #370: whether the signed-in principal may call `op` (GET /v1/me/capabilities, derived
   * from the API's own route roles, the engineering lead flag included). For an operation
   * the item decides too (`per_item`), pass `onItem`: whether this item lets the caller in
   * below the role the handler never refuses (the author, the person asked, a gap that is
   * not critical). False until the capabilities have loaded.
   */
  can: (op: Operation, onItem?: boolean) => boolean;
  /** A3: whether the signed-in principal decides the engineering stops. */
  decideEngineeringStops: boolean;
  /** True once the capabilities of the signed-in principal have loaded. */
  capsReady: boolean;
  /** Why the capabilities could not be read, or null. */
  capsError: string | null;
  /** Reads the capabilities again (after capsError). */
  retryCaps: () => void;
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
  const [capsFailed, setCapsFailed] = useState<{ key: string; error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!capsKey) return;
    let alive = true;
    const failed = (error: string) => alive && setCapsFailed({ key: capsKey, error });
    api
      .GET("/v1/me/capabilities")
      .then((res) => {
        if (!alive) return;
        if (res.data) {
          setCapsFailed(null);
          setCaps({ key: capsKey, caps: res.data });
        } else failed("Oracle could not read what your role may do.");
      })
      .catch(() => failed("Oracle could not read what your role may do."));
    return () => {
      alive = false;
    };
  }, [capsKey, attempt]);
  const current = caps && caps.key === capsKey ? caps.caps : null;
  const ops = current?.operations ?? null;
  const can = useCallback(
    (op: Operation, onItem?: boolean) => {
      if (ops?.[op] !== true) return false;
      if (!current || !(op in current.per_item)) return true;
      // The handler checks the item too: its role passes any item; below it, the item decides.
      const role = current.per_item[op];
      return (role != null && hasRole(current.role, role)) || onItem === true;
    },
    [ops, current],
  );
  const capsError = !current && capsFailed && capsFailed.key === capsKey ? capsFailed.error : null;
  const retryCaps = useCallback(() => {
    setCapsFailed(null);
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<MeState>(
    () => ({
      me: state.me,
      role: state.me?.role ?? null,
      engineeringLead: state.me?.engineering_lead ?? false,
      loading: state.loading,
      can,
      decideEngineeringStops: current?.decide_engineering_stops ?? false,
      capsReady: ops !== null,
      capsError,
      retryCaps,
      refresh,
      clear,
    }),
    [state, refresh, clear, can, ops, current, capsError, retryCaps],
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
