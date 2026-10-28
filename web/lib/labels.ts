import type { DocumentOut, Schemas } from "@/lib/api/client";

type RunOut = Schemas["RunOut"];

/*
 * Human names for runs and documents: titles and plain words, never a slug or an id.
 */

/** The word a document's kind adds to its title, where the app says it ("Usage alerts PRD"). */
const KIND_WORD: Partial<Record<DocumentOut["kind"], string>> = {
  prd: "PRD",
  roadmap: "roadmap",
  spec: "spec",
};

/** A document by its title, with its kind word when the title does not say it already: "Usage alerts PRD". */
export function docLabel(doc: { title: string; kind?: DocumentOut["kind"] | null }): string {
  const title = doc.title.trim();
  const word = doc.kind ? KIND_WORD[doc.kind] : undefined;
  if (!word || new RegExp(`\\b${word}\\b`, "i").test(title) || (doc.kind === "spec" && /\bbrief\b/i.test(title))) return title;
  return `${title} ${word}`;
}

/** A slug in words, for a run that only names its document's slug: "usage-alerts" is "Usage alerts". */
function slugWords(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type RunNamed = Pick<RunOut, "flow_title"> & Partial<Pick<RunOut, "document_slug" | "document_kind">> & { document_title?: string | null };

/**
 * A run by its document and its flow: "Usage alerts PRD · Roadmap from an approved PRD"; the
 * flow alone for a run with no document. `title` is the document's title where the caller has it.
 */
export function runLabel(run: RunNamed, title?: string | null): string {
  const named = title ?? run.document_title ?? (run.document_slug ? slugWords(run.document_slug) : null);
  return named ? `${docLabel({ title: named, kind: run.document_kind })} · ${run.flow_title}` : run.flow_title;
}
