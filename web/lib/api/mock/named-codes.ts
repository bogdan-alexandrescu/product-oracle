/**
 * The "named-codes" scenario's PRD (#305): a fictional trip planner whose agent-written text
 * uses codes with nothing beside them (F-28, F-30a, R1–R3, M2, G-B), so the reader names
 * them. F-99 is mentioned but never defined: it stays plain text.
 */
import type { DocumentSeed } from "./fixtures";

export const CODED_PRD_SLUG = "trip-planner";

export const CODED_PRD: DocumentSeed = {
  slug: CODED_PRD_SLUG,
  title: "Trip planner PRD",
  template: "oracle-default",
  template_version: "2",
  versions: [
    {
      number: 1,
      created_at: "2026-10-21T09:00:00Z",
      brief: ["title", "summary"],
      sections: [
        { key: "title", level: 1, heading: "Trip planner PRD", body: "Plan a trip with the people going on it." },
        {
          key: "summary",
          level: 2,
          heading: "Summary",
          body: "F-28 comes first, then the F-30a slice of F-30, to move G-B. R1–R3 must hold by M2; F-99 waits for a later release.\n\nSpec: https://example.com/specs/F-28 and `F-28` in code stay as written.",
        },
        { key: "full", level: 1, heading: "Full version", body: "" },
        {
          key: "f-28",
          level: 2,
          heading: "F-28 Shared trip notes",
          body: "Travellers keep notes on a trip together.\n\n- R1 (F-28) Notes save offline.\n- R2 (F-28) Notes sync when the phone reconnects.",
        },
        { key: "f-30", level: 2, heading: "F-30 Packing lists", body: "One list per trip.\n\n- R3 (F-30) A list is shared by link." },
        { key: "milestones", level: 2, heading: "Milestones", body: "- M1: Private beta with ten groups.\n- M2: Public launch." },
        { key: "decisions", level: 2, heading: "Decisions and open questions", body: "- D1 — Lists are per trip, not per traveller.\n- Q1: Who can edit a shared list?" },
      ],
      citations: [],
    },
  ],
};
