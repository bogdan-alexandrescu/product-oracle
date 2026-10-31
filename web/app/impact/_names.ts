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

function wanted(report: Report | undefined, extra?: string | null): { slugs: string[]; versions: [string, number][] } {
  const slugs = new Set<string>();
  const versions = new Map<string, [string, number]>();
  const add = (slug: string | null | undefined, n: number | null | undefined) => {
    if (!slug) return;
    slugs.add(slug);
    if (n != null) versions.set(`${slug}@${n}`, [slug, n]);
  };
  add(extra, null);
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

/** The slug of the PRD version's Impact a "?from=" names, for useNames to load its title. */
export const fromSlug = (from: string | null | undefined): string | null => {
  const m = from ? /^\/documents\/([^/?#]+)\/v\/\d+\/impact\/?$/.exec(from) : null;
  try {
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
};

/** The names an impact report needs, loaded once per set of documents it mentions. */
export function useNames(report: Report | undefined, extraSlug?: string | null): Names {
  const { slugs, versions } = wanted(report, extraSlug);
  const key = `impact-names|${slugs.join(",")}|${versions.map(([s, n]) => `${s}@${n}`).join(",")}`;
  const q = useQuery(key, () => loadNames(slugs, versions), { keepPrevious: true });
  const loaded = q.data ?? { docs: {}, headings: {}, byKey: {} };
  const doc = (slug: string) => loaded.docs[slug] ?? slugWords(slug);
  const section = (k: string, slug?: string | null, n?: number | null) =>
    (slug && n != null ? loaded.headings[`${slug}@${n}#${k}`] : undefined) ?? loaded.byKey[k] ?? slugWords(k);
  const words = (text: string) => {
    // "(flow prd_to_roadmap)" is the run's flow id: the sentence already says what it is.
    let t = text.replace(/ \(flow [\w-]+\)/g, "");
    t = t.replace(/\bsections? ([\w.-]+(?:, [\w.-]+)*)(?=[,;)]| (?:changed|was removed|of|from)\b|$)/g, (_, keys: string) => {
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

/**
 * qa-plan-12: where a recorded change's page was opened from (its "?from="), as its back link:
 * a PRD version's Impact ("Impact of Checkout redesign PRD v2"). Anything else (or a path that
 * is not this site's) is ignored, and the page leads back to what the change is about.
 */
export function parseFrom(from: string | null | undefined, names: Names): { href: string; label: string } | null {
  if (!from || !from.startsWith("/") || from.startsWith("//")) return null;
  const m = /^\/documents\/([^/?#]+)\/v\/(\d+)\/impact\/?$/.exec(from);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { href: `/documents/${encodeURIComponent(slug)}/v/${m[2]}/impact`, label: `Impact of ${names.doc(slug)} v${m[2]}` };
}

/** What a change did, in words: "edited", "deleted", "permission changed". */
const CAUSE: Record<string, string> = {
  section_edited: "edited",
  section_removed: "removed",
  entity_deleted: "deleted",
  entity_changed: "changed",
  source_permission: "permission changed",
};
const causeWords = (cause: string) => CAUSE[cause] ?? cause.replace(/^(?:section|document|version|entity)_/, "").replaceAll("_", " ");

export type SubjectWords = {
  /** "Checkout redesign PRD v2 › Success metrics section edited". */
  title: string;
  /** The title without the version it names ("Success metrics section edited"), for a page whose back link names it. */
  short: string;
  /** The version the title starts with ("Checkout redesign PRD v2"), when it names one. */
  where: string | null;
  /** Where the report's subject lives, for the back link: "Checkout redesign PRD v2" at its version page. */
  back: { href: string; label: string } | null;
  /** The document and version the subject names, where it names one: the lineage shows that version. */
  version: { slug: string; n: number } | null;
};

/**
 * The report's subject in words (qa-plan-10, 58, 59): never "slug@2#metrics" or "requirement:R-90".
 * A recorded change names its document version and section; a what-if names the baseline item.
 */
export function subjectWords(report: Report, names: Names): SubjectWords {
  const c = report.change;
  const ref = c?.subject_ref ?? report.subject.ref ?? null;
  const p = parseRef(ref);
  if (p && p.n != null) {
    const where = `${names.doc(p.slug)} v${p.n}`;
    const what = c ? (p.key ? `${names.section(p.key, p.slug, p.n)} section ${causeWords(c.cause)}` : causeWords(c.cause)) : null;
    const title = report.subject.title && !c ? report.subject.title : what ? `${where} › ${what}` : where;
    return {
      title,
      short: c && p.key && what ? what : title,
      where,
      back: { href: `/documents/${p.slug}/v/${p.n}`, label: where },
      version: { slug: p.slug, n: p.n },
    };
  }
  const kindKey = ref ? /^([a-z_]+):(.+)$/.exec(ref) : null;
  const kind = kindKey?.[1] ?? c?.subject_kind ?? report.subject.kind;
  const titled = report.subject.title;
  // A recorded change on a baseline item: its kind and title, quoted ("Requirement “Guest checkout
  // keeps the cart” deleted"), so the verb never reads as part of the title.
  const named =
    titled && c && kindKey
      ? `${slugWords(kindKey[1])} “${titled}”`
      : (titled ?? (kindKey ? `${slugWords(kindKey[1])} ${kindKey[2]}` : ref ? names.words(ref) : slugWords(kind)));
  const title = c ? `${named} ${causeWords(c.cause)}` : named;
  const back =
    kind === "source"
      ? { href: "/sources", label: "Sources" }
      : ["member", "intake", "access_request"].includes(kind)
        ? null
        : { href: "/baseline", label: "Baseline" };
  return { title, short: title, where: null, back, version: null };
}
