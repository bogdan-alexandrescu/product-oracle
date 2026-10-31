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

type RunDecision = Schemas["RunDecision"];

/**
 * qa4-work-29: a decision as a sentence, from its fields (the API's summary is the terse line
 * the run's agents read): "PRD review was skipped: it was turned off when the run started."
 * `checkpoint` is its name as the page writes it ("The baseline", "Feature set and
 * dependencies"). Review minors 2: where the page knows who decided, `name` stands in for the
 * role ("approved by Ana Example", never "by an owner"); else the role, as the agents read it.
 */
export function decisionSentence(
  d: Pick<RunDecision, "status" | "via" | "note" | "delivered" | "decided_by_role">,
  checkpoint: string,
  name?: string | null,
): string {
  const role = d.decided_by_role;
  const by = name ? ` by ${name}` : role ? ` by ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}` : "";
  const via = d.via === "swarmcloud_console" ? " in SwarmCloud's console" : "";
  const done = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
  const what =
    d.status === "approved"
      ? `${checkpoint} was approved${by}${via}`
      : d.status === "skipped"
        ? `${checkpoint} was skipped${by}${via}`
        : `Changes were asked for at ${checkpoint === "The baseline" ? "the baseline" : checkpoint}${by}${via}`;
  let out: string;
  if (!d.note) out = `${what}.`;
  else if (d.status === "skipped" && /^Turned off when the run started/.test(d.note)) out = `${what}: it was turned off when the run started.`;
  else out = `${what}. Note: ${done(d.note)}`;
  return d.delivered === false ? `${out} Not delivered to the run yet.` : out;
}
