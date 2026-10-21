/**
 * Where Oracle's own links to a version land (E2 "First tab", owner 2026-10-21): a roadmap
 * version opens on its Items tab, a PRD version on the version itself. Only links Oracle
 * draws go through here; a typed or shared URL is never redirected, and a link to a
 * section (`sectionHref`) still opens that section on the Document tab.
 */

/** The pane a roadmap version opens on from Oracle's links. */
export const ROADMAP_DEFAULT_PANE = "items";

export type DocumentKind = "prd" | "roadmap" | string | null | undefined;

/** `/documents/{doc}/v/{n}`, plus `/items` for a roadmap. */
export function versionHref(doc: string, kind: DocumentKind, n: number | string): string {
  const base = `/documents/${doc}/v/${n}`;
  return kind === "roadmap" ? `${base}/${ROADMAP_DEFAULT_PANE}` : base;
}
