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
 * A run by its document's own title and its flow: "Usage alerts · Roadmap from an approved PRD"
 * (no kind word added: the title is the document's, as written); the flow alone for a run with
 * no document. `title` is the document's title where the caller has it.
 */
export function runLabel(run: RunNamed, title?: string | null): string {
  const named = (title ?? run.document_title)?.trim() || (run.document_slug ? slugWords(run.document_slug) : null);
  return named ? `${named} · ${run.flow_title}` : run.flow_title;
}

/**
 * A run decision's line naming who decided (review minors 2): "<what> · <how> · note: …" with
 * the "how" built from the decision's fields, so the name stands in for the role whatever the
 * role phrase reads; no name, the API's line as it is.
 */
export function decisionLine(d: Pick<Schemas["RunDecision"], "summary" | "status" | "via">, name: string | null | undefined): string {
  if (!name) return d.summary;
  const [what, , ...rest] = d.summary.split(" · ");
  const how = `${d.status.replace("_", " ")} by ${name}${d.via === "swarmcloud_console" ? " in SwarmCloud's console" : ""}`;
  return [what, how, ...rest].join(" · ");
}
