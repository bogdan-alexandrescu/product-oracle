"use client";

import { createContext, useContext } from "react";

import { api, unwrap } from "@/lib/api/client";
import { docLabel } from "@/lib/labels";
import { useQuery } from "@/lib/use-query";

import type { Report } from "./_lib";

/*
 * Human names for what an impact report points at by reference (qa-plan-10): a document by
 * its title ("Checkout redesign PRD"), a section by its heading ("Success metrics"), never a
 * slug, "slug@2#metrics" or a section key. The report carries slugs, version numbers and
 * section keys; the documents and versions it names give their titles and headings.
 */

export type Names = {
  /** "Checkout redesign PRD"; the slug in words until the document has loaded. */
  doc: (slug: string) => string;
  /** "Success metrics": a section's heading without its number; the key in words until known. */
  section: (key: string, slug?: string | null, n?: number | null) => string;
  /** Server text with section keys and slugs in it, in words. */
  words: (text: string) => string;
};

/** "checkout-redesign@2#metrics" → { slug, n, key }. */
export function parseRef(ref: string | null | undefined): { slug: string; n: number | null; key: string | null } | null {
  const m = ref ? /^([a-z0-9][\w-]*)@(\d+)(?:#(.+))?$/i.exec(ref) : null;
  return m ? { slug: m[1], n: Number(m[2]), key: m[3] ?? null } : null;
}

const slugWords = (slug: string) => {
  const w = slug.replace(/[-_]+/g, " ").trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** "6. Success metrics" → "Success metrics". */
const bareHeading = (h: string) => h.replace(/^\s*(?:\d+(?:\.\d+)*\.?|[A-Z]\.)\s+/, "").trim() || h;

function wanted(report: Report | undefined): { slugs: string[]; versions: [string, number][] } {
  const slugs = new Set<string>();
  const versions = new Map<string, [string, number]>();
  const add = (slug: string | null | undefined, n: number | null | undefined) => {
    if (!slug) return;
    slugs.add(slug);
    if (n != null) versions.set(`${slug}@${n}`, [slug, n]);
  };
  if (report) {
    const subj = parseRef(report.change?.subject_ref ?? report.subject.ref);
    if (subj) add(subj.slug, subj.n);
    for (const o of report.affected) for (const d of o.dependencies ?? []) add(d.upstream.document_slug, d.upstream.version_number);
  }
  return { slugs: [...slugs].sort(), versions: [...versions.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]) };
}

type Loaded = { docs: Record<string, string>; headings: Record<string, string>; byKey: Record<string, string> };

async function loadNames(slugs: string[], versions: [string, number][]): Promise<Loaded> {
  const out: Loaded = { docs: {}, headings: {}, byKey: {} };
  await Promise.all([
    ...slugs.map(async (slug) => {
      try {
        const d = await unwrap(api.GET("/v1/documents/{doc}", { params: { path: { doc: slug } } }));
        out.docs[slug] = docLabel(d);
      } catch {
        // A document the reader cannot open keeps its slug in words.
      }
    }),
    ...versions.map(async ([slug, n]) => {
      try {
        const v = await unwrap(api.GET("/v1/documents/{doc}/versions/{n}", { params: { path: { doc: slug, n } } }));
        for (const s of v.sections) {
          const h = bareHeading(s.heading);
          out.headings[`${slug}@${n}#${s.section_key}`] = h;
          out.byKey[s.section_key] ??= h;
        }
      } catch {
        // As above: the key in words.
      }
    }),
  ]);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names an impact report needs, loaded once per set of documents it mentions. */
export function useNames(report: Report | undefined): Names {
  const { slugs, versions } = wanted(report);
  const key = `impact-names|${slugs.join(",")}|${versions.map(([s, n]) => `${s}@${n}`).join(",")}`;
  const q = useQuery(key, () => loadNames(slugs, versions), { keepPrevious: true });
  const loaded = q.data ?? { docs: {}, headings: {}, byKey: {} };
  const doc = (slug: string) => loaded.docs[slug] ?? slugWords(slug);
  const section = (k: string, slug?: string | null, n?: number | null) =>
    (slug && n != null ? loaded.headings[`${slug}@${n}#${k}`] : undefined) ?? loaded.byKey[k] ?? slugWords(k);
  const words = (text: string) => {
    let t = text.replace(/\bsections? ([\w.-]+(?:, [\w.-]+)*)(?= (?:changed|was removed|of)\b)/g, (_, keys: string) => {
      const list = keys.split(", ").map((k) => `“${section(k)}”`);
      return list.length === 1 ? `the ${list[0]} section` : `the ${list.join(", ")} sections`;
    });
    // Longest first, so "checkout-redesign-spec" is not read as "checkout-redesign".
    for (const slug of [...slugs].sort((a, b) => b.length - a.length)) {
      t = t.replace(new RegExp(`(^|[\\s(])${escape(slug)}(?=$|[\\s),.;:])`, "g"), (_, pre: string) => `${pre}${doc(slug)}`);
    }
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  return { doc, section, words };
}

const slugOnly: Names = { doc: slugWords, section: (k) => slugWords(k), words: (t) => t };

/** The report's names, for the explorer's parts (ImpactExplorer provides them). */
export const NamesContext = createContext<Names>(slugOnly);
export const useNamesOf = () => useContext(NamesContext);
