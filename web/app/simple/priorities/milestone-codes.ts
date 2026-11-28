import { api, type Schemas } from '@/lib/api/client';
import { useQuery } from '@/lib/use-query';

type Read = Schemas['SimpleRoadmapOut'];
type By = NonNullable<Parameters<typeof codedMilestone>[2]>;

/** A name that already starts with its code ("M6 · Beta", "F-26: Keys"). */
const CODED = /^[A-Z][A-Z0-9]*-?\d+[a-z]?(\s|·|:|$)/;

/** A milestone name's own code ("M1 · Beta": M1, Beta), as the API's roadmap_codes.split reads it. */
const OWN = /^(M\d{1,2})(?![\w.])\s*[·:\-–—]?\s*(.*)$/i;

/** A name without its own code, for matching ("M1 · Beta" and "Beta" are one name). */
const bare = (name: string): string => OWN.exec(name.trim())?.[2]?.trim() || name.trim();

/**
 * qa-nov17 G8: a milestone's code and name as the roadmap reads it ("M6 Beta"), so one milestone has one name on
 * Priorities, the Goal buckets and the Roadmap: by its id (a goal milestone or a dated one), else by its PRD and the
 * PRD's own code (a PRD's key date "M1 · Beta"), else by its name (the one the item is in first). Its name alone when
 * the roadmap gives it no code, or two codes share the name.
 * #1894: a name that carries a PRD's own number ("M1 · Beta") shows the roadmap's one code in its place ("M6 Beta"),
 * never both, so "M1" never names two milestones.
 */
type Known = {
  id: string;
  name: string;
  code: string | null | undefined;
  own: string | null;
  prd: { id: string; slug: string } | null;
  item_ids: string[];
};

/** Every milestone the roadmap's read names, with its roadmap code and (a PRD's) own code. */
function known(read: Read): Known[] {
  return [
    ...read.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      code: m.roadmap_code,
      own: null,
      prd: null,
      item_ids: m.item_ids,
    })),
    ...(read.goal_milestones ?? [])
      .filter((m) => !m.goal_target)
      .map((m) => ({
        id: m.id,
        name: m.name,
        code: m.roadmap_code ?? m.code,
        own: m.code ? m.code.toUpperCase() : null,
        prd: m.prd ?? null,
        item_ids: m.item_ids,
      })),
  ];
}

/** The milestones a name means: by id, else by its PRD and own code, else by its name. */
function matching(all: Known[], name: string, own: RegExpExecArray | null, by: By): Known[] {
  // A PRD plan's own track milestone the roadmap gives no code ("M3 · Open to all") reads its PRD milestone's, by name.
  const byId = by.id ? all.find((m) => m.id === by.id && (m.code || !own)) : undefined;
  if (byId) return [byId];
  const prd = by.prd;
  if (own && prd) {
    const byPrd = all.filter(
      (m) => (m.prd?.id === prd.id || m.prd?.slug === prd.slug) && m.own === own[1].toUpperCase(),
    );
    if (byPrd.length) return byPrd;
  }
  return all.filter((m) => (own ? bare(m.name) === bare(name) : m.name === name));
}

/**
 * #1894: a PRD's own number the roadmap does not give is never shown: the PRD milestone's name ("M2 (60% by Dec)"
 * reads "Scale volume (60% by Dec)", by its roadmap code when it has one), else the words after the number.
 */
function withoutOwnNumber(read: Read, name: string, own: RegExpExecArray, by: By): string {
  const tail = own[2].trim();
  const mine = by.plan?.find((m) => m.code.toUpperCase() === own[1].toUpperCase());
  if (mine && bare(mine.name) !== bare(tail)) {
    const head = codedMilestone(read, `${own[1]} · ${bare(mine.name)}`, { prd: by.prd });
    return tail.startsWith('(') ? `${head} ${tail}` : head;
  }
  return tail || name;
}

/**
 * qa-nov17 G8: a milestone's code and name as the roadmap reads it ("M6 Beta"), so one milestone has one name on
 * Priorities, the Goal buckets and the Roadmap: by its id (a goal milestone or a dated one), else by its PRD and the
 * PRD's own code (a PRD's key date "M1 · Beta"), else by its name (the one the item is in first). Its name alone when
 * the roadmap gives it no code, or two codes share the name.
 * #1894: a name that carries a PRD's own number ("M1 · Beta") shows the roadmap's one code in its place ("M6 Beta"),
 * never both, so "M1" never names two milestones.
 */
export function codedMilestone(
  read: Read | undefined,
  name: string,
  by: {
    id?: string | null;
    itemId?: string | null;
    prd?: { id: string; slug: string } | null;
    /** The PRD's own plan milestones (SimplePlanOut.milestones), whose numbers are the PRD's, not the roadmap's. */
    plan?: readonly { code: string; name: string }[];
  } = {},
): string {
  const own = OWN.exec(name.trim());
  if (!own && CODED.test(name)) return name;
  if (!read) return name;
  const named = matching(known(read), name, own, by);
  const held = by.itemId ? named.filter((m) => m.item_ids.includes(by.itemId!)) : [];
  const codes = [
    ...new Set((held.length ? held : named).map((m) => m.code).filter((c): c is string => !!c)),
  ];
  if (codes.length === 1)
    return own ? `${codes[0]} ${own[2].trim() || own[1].toUpperCase()}` : `${codes[0]} ${name}`;
  if (!own) return name;
  // The roadmap shows it by the number its own name carries ("M1 · Prove it", no roadmap-wide code): as it is.
  if (named.some((m) => OWN.exec(m.name.trim())?.[1]?.toUpperCase() === own[1].toUpperCase()))
    return name;
  return withoutOwnNumber(read, name, own, by);
}

/**
 * The page's coder: the roadmap's read (the one the buckets' tasks read, task-edit's useRoadmapItems) gives each
 * milestone its code. ``ready``: the read has landed (or failed), so a milestone is drawn once, with its code (#1882).
 */
export function useCodedMilestone(): ((name: string, by?: By) => string) & { ready: boolean } {
  const q = useQuery('simple-roadmap:{}', async () => {
    const { data } = await api.GET('/v1/simple/roadmap', {});
    if (!data) throw new Error('Could not read the roadmap');
    return data;
  });
  const read = q.data;
  return Object.assign((name: string, by?: By) => codedMilestone(read, name, by), {
    ready: !!read || !!q.error,
  });
}

/**
 * #1894: a line's words with its milestone by the roadmap's one code: a milestone's line, or a PRD's key date
 * ("M2 · Scale volume · Dec 25, 2026" reads "M3 Scale volume · Dec 25, 2026"), in the picker and in the rows' heads.
 */
export function codedLine(
  coded: (
    name: string,
    by?: { id?: string | null; prd?: { id: string; slug: string } | null },
  ) => string,
  l: { key: string; kind: string; prd?: { id: string; slug: string } | null },
  words: string,
): string {
  if (l.kind !== 'milestone' && !(l.kind === 'key_date' && l.prd)) return words;
  const at = words.lastIndexOf(' · ');
  if (at < 0) return words;
  const id = l.key.startsWith('milestone:') ? l.key.slice('milestone:'.length) : null;
  return `${coded(words.slice(0, at), { id, prd: l.kind === 'key_date' ? l.prd : null })}${words.slice(at)}`;
}

/**
 * #1894: a plan milestone as a person reads it: the roadmap's one code and its name ("M23 Prove it"), else its name
 * alone, never the PRD's own number.
 */
export function planMilestone(
  coded: (name: string, by?: By) => string,
  plan: {
    prd: { id: string; slug: string };
    milestones: readonly { code: string; name: string }[];
  },
  code: string,
): { code: string | null; name: string } {
  const m = plan.milestones.find((x) => x.code === code);
  const words = coded(`${code} · ${m?.name || code}`, { prd: plan.prd });
  const own = OWN.exec(words);
  return own
    ? { code: own[1].toUpperCase(), name: own[2] || m?.name || '' }
    : { code: null, name: m?.name || words };
}
