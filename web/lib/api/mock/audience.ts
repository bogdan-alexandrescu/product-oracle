/**
 * O5 lane 1 (as api/oracle/roadmap/variants.py): the roadmap audience registry and the
 * `audience=` parameter of a version's export and deck.
 *
 * The mock renders an audience from the version's sections: it drops the audience's
 * hidden sections (and their sub-sections) and, for Board, the item cards that serve no
 * confirmed goal, with the line "N items serve no confirmed goal and are left out". The
 * API also rebuilds the item rows from the version's roadmap items; the mock keeps the
 * cards as written.
 */
import type { Schemas } from "@/lib/api/client";

type Audience = Schemas["AudienceOut"]["key"];
type Section = { section_key: string; level: number; heading: string; body_md: string; body_text: string };

const ALWAYS = ["layout"];
const TEAM_FIELDS = ["confidence", "depends_on", "horizon", "milestone", "outcome", "title"];

export const AUDIENCES: Schemas["AudienceOut"][] = [
  {
    key: "board",
    label: "Board",
    hidden_sections: [...ALWAYS, "sources", "changes", "risks", "dependencies", "capacity", "drift", "launch", "no-goal"].sort(),
    item_fields: ["confidence", "horizon", "outcome", "risk", "title"],
    group_by: "goal",
    max_items_per_horizon: 7,
    appendix: false,
  },
  { key: "team", label: "Team", hidden_sections: ALWAYS, item_fields: TEAM_FIELDS, group_by: "goal", max_items_per_horizon: null, appendix: true },
  {
    key: "engineering",
    label: "Engineering",
    hidden_sections: ALWAYS,
    item_fields: [...TEAM_FIELDS, "effort", "tracker"].sort(),
    group_by: "team",
    max_items_per_horizon: null,
    appendix: true,
  },
  { key: "public", label: "Public", hidden_sections: [], item_fields: [], group_by: "stage", max_items_per_horizon: null, appendix: false },
];

const NO_GOAL = "serves no confirmed goal";

export function isAudience(value: string | null): value is Audience {
  return !!value && AUDIENCES.some((a) => a.key === value);
}

export function audienceLabel(audience: Audience): string {
  return AUDIENCES.find((a) => a.key === audience)!.label;
}

/**
 * The API's refusals, in its order: Public below approver (or for a run) 403; markdown
 * 422; not a roadmap 422; Public 409 public_not_ready (lane 2 builds it).
 */
export function audienceRefusal(
  audience: string | null,
  kind: string | undefined,
  role: string,
  format: string,
): { status: number; body: unknown } | null {
  if (audience === null) return null;
  if (!isAudience(audience)) return { status: 422, body: { detail: `unknown audience '${audience}'` } };
  if (audience === "public" && role !== "owner" && role !== "approver") {
    return { status: 403, body: { detail: "The Public audience needs the approver role" } };
  }
  if (format === "md") return { status: 422, body: { detail: "markdown is the stored text; export an audience as html, pdf or pptx" } };
  if (kind !== "roadmap") return { status: 422, body: { detail: `audience is offered for roadmaps only; this is a ${kind ?? "prd"}` } };
  if (audience === "public") {
    return {
      status: 409,
      body: {
        detail: {
          code: "public_not_ready",
          message:
            "The Public version of this roadmap is built from approved public texts and needs a public check first; it is never made by removing things from the internal text",
        },
      },
    };
  }
  return null;
}

/** The sections of one rendering in `audience` (see the file comment). */
export function audienceSections<S extends Section>(sections: S[], audience: Audience): S[] {
  const hidden = new Set(AUDIENCES.find((a) => a.key === audience)!.hidden_sections);
  const out: S[] = [];
  let skip: number | null = null;
  let leftOut = 0;
  for (const s of sections) {
    if (skip !== null) {
      if (s.level > skip) continue;
      skip = null;
    }
    const goalless = s.level >= 3 && s.body_md.toLowerCase().includes(NO_GOAL);
    if (hidden.has(s.section_key) || (audience === "board" && goalless)) {
      if (!hidden.has(s.section_key)) leftOut++;
      skip = s.level;
      continue;
    }
    out.push(s);
  }
  if (!leftOut) return out;
  const line = leftOut === 1 ? "1 item serves no confirmed goal and is left out." : `${leftOut} items serve no confirmed goal and are left out.`;
  const at = out.findIndex((s) => s.section_key === "brief-items");
  if (at >= 0) {
    const s = out[at];
    out[at] = { ...s, body_md: `${s.body_md}\n\n${line}`, body_text: `${s.body_text}\n\n${line}` };
  }
  return out;
}
