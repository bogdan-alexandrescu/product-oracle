"use client";

import { useEffect, useMemo, useState } from "react";

import { api, unwrap, type EntityOut } from "@/lib/api/client";
import { buildCodeIndex, type CodeEntity, type CodeIndex } from "@/lib/code-index";
import { useMe } from "@/lib/me";

/**
 * Named codes (#304). A code is the company's own: written before the name in the title
 * ("G-B Growth", "OKR-2: Retention"), else a key that is itself code-shaped ("F-2"). Place
 * codes (G1, G2 by position) and slugs ("g-b-growth") are never shown.
 */
const CODE = String.raw`[A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+|[A-Z]{1,4}\d+`;
const TITLED = new RegExp(String.raw`^(${CODE})\s*(?:[:·–—]\s*|\s)(\S.*)$`);
const KEYED = new RegExp(String.raw`^(?:${CODE})$`);

export type Named = { code: string | null; name: string };

/** A title's code and name: "G-B Growth" → G-B, Growth; "Raise activation" → no code. */
export function named(title: string, key?: string | null): Named {
  const m = title.trim().match(TITLED);
  if (m) return { code: m[1], name: m[2] };
  return { code: key && KEYED.test(key) ? key : null, name: title };
}

/** "G-B Growth", or the name alone when there is no code: the words a code reads as in text. */
export const namedText = (n: Named) => (n.code ? `${n.code} ${n.name}` : n.name);

export type Names = {
  byKey: Map<string, EntityOut>;
  byId: Map<string, EntityOut>;
};

const TTL = 60_000;
/** One lookup per company, shared by every chip on every page, refreshed after a minute. */
const cache = new Map<string, { at: number; names: Promise<Names> }>();

function load(company: string): Promise<Names> {
  const hit = cache.get(company);
  if (hit && Date.now() - hit.at < TTL) return hit.names;
  const names = unwrap(api.GET("/v1/baseline/entities")).then((list) => {
    const all = list.filter((e) => (e.type === "goal" || e.type === "feature") && e.status !== "rejected");
    return { byKey: new Map(all.map((e) => [e.key, e])), byId: new Map(all.map((e) => [e.id, e])) };
  });
  names.catch(() => cache.delete(company));
  cache.set(company, { at: Date.now(), names });
  return names;
}

/** The company's goals and features by key and id; undefined until loaded. */
export function useNames(): Names | undefined {
  const { me } = useMe();
  const company = me ? (me.tenant_id ?? "me") : null;
  const [state, setState] = useState<{ company: string; names: Names } | null>(null);
  useEffect(() => {
    if (!company) return;
    let live = true;
    load(company)
      .then((names) => live && setState({ company, names }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [company]);
  return state && state.company === company ? state.names : undefined;
}

/**
 * The company's goals and features that carry a code, for the codes in agent-written text
 * (#305): "G-B Growth" is known as G-B, a feature keyed F-2 as F-2.
 */
export function useCodeEntities(): CodeEntity[] {
  const names = useNames();
  return useMemo(
    () =>
      names
        ? [...names.byId.values()].flatMap((e) => {
            const n = named(e.title, e.key);
            return n.code ? [{ id: e.id, kind: e.type === "goal" ? ("Goal" as const) : ("Feature" as const), code: n.code, name: n.name, status: e.status }] : [];
          })
        : NO_ENTITIES,
    [names],
  );
}

const NO_ENTITIES: CodeEntity[] = [];

/** The codes plain agent-written text can name: the company's goals and features. */
export function useCompanyCodes(): CodeIndex {
  const entities = useCodeEntities();
  return useMemo(() => buildCodeIndex([], entities), [entities]);
}
