import type { Schemas } from '../client';
import { companyDayIso } from './connections';

type RunOut = Schemas['RunOut'];
type NoteCode = Schemas['SimpleNoteCode'];

// #1866, as the API's oracle.simple.note_codes: a code as people write it (F-104, F-15b, G-2, G2, G-B, M7).
const CODE = /(?<![\w-])([A-Z]{1,3}-\d{1,5}[a-j]?|[A-Z]\d{1,4}|[A-Z]-[A-Z]\d{0,3})(?![\w-])/g;
const GOAL = /^G-?(?:\d+|[A-Z]\d*)$/;
const MILESTONE = /^M-?(\d+)$/;
const flat = (code: string) => code.replace(/-/g, '').toLowerCase();

/** The codes a note writes, each once, in its order (note_codes.written). */
const written = (note: string | null | undefined) => [
  ...new Set([...(note ?? '').matchAll(CODE)].map((m) => m[1])),
];

/**
 * #1866, as note_codes.names: each code the notes write that names one of the company's features (by its code), confirmed
 * goals (by key, any case, with or without the dash) or milestones (by code, when every milestone of that code has one name).
 */
export function noteCodeNames(
  notes: (string | null | undefined)[],
  company: {
    features: { code: string; title: string }[];
    goals: { key: string; title: string }[];
    milestones: { code?: string | null; name: string }[];
  },
): Record<string, NoteCode> {
  const out: Record<string, NoteCode> = {};
  for (const code of new Set(notes.flatMap(written))) {
    const m = MILESTONE.exec(code);
    if (GOAL.test(code)) {
      const g = company.goals.find((x) => flat(x.key) === flat(code) && x.title.trim());
      if (g) out[code] = { code, name: g.title.trim(), kind: 'goal' };
    } else if (m) {
      const names = new Set(
        company.milestones
          .filter((x) => x.code === `M${m[1]}` && x.name.trim())
          .map((x) => x.name.trim()),
      );
      if (names.size === 1) out[code] = { code, name: [...names][0], kind: 'milestone' };
    } else {
      const f = company.features.find((x) => x.code === code);
      const name = f?.title.replace(new RegExp(`^${code}\\s+`), '').trim();
      if (name && name !== code) out[code] = { code, name, kind: 'feature' };
    }
  }
  return out;
}

const codesOf = (note: string | null | undefined, named: Record<string, NoteCode>) =>
  written(note).flatMap((c) => (named[c] ? [named[c]] : []));

// As the API's _STOP_WORDS (oracle.simple.meetings): a run's stops as people name them in Simple.
const STOP_WORDS: Record<string, string> = {
  baseline_confirm: 'Ground Truth',
  feature_set: 'Feature set',
  eng_review: 'Engineering check',
  priority_order: 'Order',
  prd_review: 'PRD review',
  eng_dates: 'Dates',
  roadmap_items: 'Roadmap items',
  roadmap_review: 'Roadmap review',
};
const STEP_WORDS: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Sent back',
  skipped: 'Skipped',
};

/** As the API's eng_dates.changed_count: the dates an approval at the Dates stop changed, a proposed date made No date among them. */
const datesChanged = (c: RunOut['checkpoints'][number]) =>
  c.kind === 'eng_dates' && c.status === 'approved'
    ? Object.values(
        (c.payload.dates ?? {}) as Record<string, { decision?: string; removed?: boolean }>,
      ).filter((d) => d?.decision === 'changed' || d?.removed).length
    : 0;
/** As the API's _approved_words: "Approved with one date changed". */
const stepWords = (c: RunOut['checkpoints'][number]) => {
  const n = datesChanged(c);
  if (c.status !== 'approved' || !n) return STEP_WORDS[c.status] ?? c.status;
  return `Approved with ${n === 1 ? 'one date' : `${n} dates`} changed`;
};

const words = (kind: string) =>
  STOP_WORDS[kind] ?? kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * build-rundecide RD1 a, as the API's _run_groups: each run on a PRD the page lists with a decided
 * stop, newest first (20 at most); its stops in order, one row per stop, a stop sent back and then
 * approved one row with its steps. Skipped stops are not people's decisions and are left out.
 */
export function runGroupsOut(
  runs: RunOut[],
  docs: { id: string; slug: string; title: string }[],
  members: { id: string; name: string }[],
  prd?: string | null,
  named: Record<string, NoteCode> = {},
): Schemas['SimpleRunGroup'][] {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const shown = docs.filter((d) => !prd || d.slug === prd || d.id === prd);
  return [...runs]
    .filter((r) => shown.some((d) => d.id === r.document_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)
    .flatMap((r) => {
      const doc = shown.find((d) => d.id === r.document_id)!;
      const decided = r.checkpoints
        .filter((c) => c.status === 'approved' || c.status === 'changes_requested')
        .sort(
          (a, b) =>
            (a.segment_seq ?? 0) - (b.segment_seq ?? 0) ||
            (a.decided_at ?? '~').localeCompare(b.decided_at ?? '~'),
        );
      const byStop = new Map<string, typeof decided>();
      for (const c of decided)
        byStop.set(`${c.segment_seq ?? 0}|${c.kind}`, [
          ...(byStop.get(`${c.segment_seq ?? 0}|${c.kind}`) ?? []),
          c,
        ]);
      const who = (c: (typeof decided)[number]) => {
        const by = (c.payload.decided as { by?: string | null } | undefined)?.by ?? c.decided_by;
        return (by && names.get(by)) || null;
      };
      const stops = [...byStop.values()].map((steps) => {
        const last = steps[steps.length - 1]!;
        const sentBack = steps.slice(0, -1).some((c) => c.status === 'changes_requested');
        const role = (last.payload.decided as { role?: string | null } | undefined)?.role ?? null;
        return {
          checkpoint_id: last.id,
          kind: last.kind,
          stop: words(last.kind),
          outcome:
            last.status === 'approved' && sentBack ? 'Approved after a change' : stepWords(last),
          dates_changed: datesChanged(last),
          who: who(last),
          role: role ? role.replace(/_/g, ' ') : null,
          day: last.decided_at ? companyDayIso(last.decided_at) : null,
          note: last.note ?? null,
          codes: codesOf(last.note, named),
          trail:
            steps.length > 1
              ? steps.map((c) => ({
                  what: stepWords(c),
                  who: who(c),
                  day: c.decided_at ? companyDayIso(c.decided_at) : null,
                  note: c.note ?? null,
                  codes: codesOf(c.note, named),
                }))
              : [],
        };
      });
      if (!stops.length) return [];
      return [
        {
          run_id: r.id,
          name: `${doc.title.trim().replace(/\s+PRD$/i, '')} plan`,
          prd: { id: doc.slug, title: doc.title },
          stops,
        },
      ];
    });
}
