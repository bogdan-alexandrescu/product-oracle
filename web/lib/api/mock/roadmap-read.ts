/**
 * prd-reads-working-draft (api/oracle/simple/roadmap_of_record.py): which company roadmap a
 * PRD's run read, in its words: the working draft when it holds edits newer than the
 * published version ("Company roadmap, working draft (edited Nov 5, 2026, 11:40 PM PST)"),
 * else the published version ("Company roadmap v7 (published Nov 4)"); null with no company
 * roadmap. Month first, in the company's time zone. The draft is read only when the person who
 * starts the run may see it (`sees`: the drafts' own rule, seesDraft); else the published version.
 */
import { formatInZone, zoneDay } from "@/lib/dates";

type Doc = { id: string; slug: string; kind: string; company_roadmap?: boolean };
type Version = { document_id: string; number: number; approved_at?: string | null };
type Draft = { roadmap: string; out: { id: string; status: string } };
type Change = { at: string; draft_ids?: string[] | null };

const NAME = "Company roadmap";

export function roadmapRead<D extends Draft>(documents: Doc[], versions: Version[], simple: { drafts?: D[]; changes?: Change[] } | undefined, zone: string, sees: (d: D) => boolean): string | null {
  const doc = documents.find((d) => d.company_roadmap && d.kind === "roadmap");
  if (!doc) return null;
  const own = versions.filter((v) => v.document_id === doc.id).sort((a, b) => a.number - b.number);
  const published = own.filter((v) => v.approved_at).at(-1);
  const draft = (simple?.drafts ?? []).find((d) => d.roadmap === doc.slug && ["working", "submitted"].includes(d.out.status) && sees(d));
  const edited = draft
    ? (simple?.changes ?? [])
        .filter((c) => (c.draft_ids ?? []).includes(draft.out.id))
        .map((c) => c.at)
        .sort()
        .at(-1)
    : undefined;
  if (draft && edited && (!published?.approved_at || Date.parse(edited) > Date.parse(published.approved_at))) {
    const at = formatInZone(edited, zone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ at /, ", ");
    return `${NAME}, ${draft.out.status === "working" ? "working draft" : "draft in review"} (edited ${at})`;
  }
  if (published?.approved_at) return `${NAME} v${published.number} (published ${zoneDay(published.approved_at, zone)})`;
  const latest = own.at(-1);
  return latest ? `${NAME} v${latest.number} (not published yet)` : `${NAME} (empty)`;
}
