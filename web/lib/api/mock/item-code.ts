// The code an item shows, as the API reads it (oracle.simple.service, oracle.roadmap.codes).

/** The PRD's own code of a section an item came from ("f-06" -> "F-06"); null when the key is no code (service.py). */
export function prdCode(section: string | null | undefined): string | null {
  const m = /^([a-z]{1,3})-(\d+)$/i.exec((section ?? '').trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/** roadmap-edit-fixes (service.coded_title): an item whose title carries its code ("F-07
 * Alpha") reads as code F-07 and name Alpha; else its code and title. */
export function codedTitle(title: string, code: string | null): [string | null, string] {
  const m = /^([A-Z][A-Z0-9]*-\d+[a-z]?)\s+(\S.*)$/.exec(title);
  if (!m || (code && code !== m[1])) return [code, title];
  return [m[1], m[2].trim()];
}

/** oracle.roadmap.codes.shown: the code a person sees on an item: unique-codes (Nov 23), its own, the one its title
 * leads with; else its Ground Truth feature's (``featureCode``), else its PRD section's. */
export function shownCode(
  item: CodedItem,
  featureCode: (id: string) => string | null | undefined,
): string | null {
  return codedTitle(item.title, ownCode(item, featureCode))[0];
}

/** oracle.roadmap.codes.named: an item as a person reads it, the code it shows then its name ("F-31 Shipping step"). */
export function shownName(
  item: CodedItem,
  featureCode: (id: string) => string | null | undefined,
): string {
  const [code, name] = codedTitle(item.title, ownCode(item, featureCode));
  return code ? `${code} ${name}` : name;
}

/** QA goal map codes (goal_map.build): an item's name as the roadmap reads it, without a leading code of its own. */
export function shownTitle(
  item: CodedItem,
  featureCode: (id: string) => string | null | undefined,
): string {
  return codedTitle(item.title, ownCode(item, featureCode))[1];
}

type CodedItem = { title: string; feature_id?: string | null; section?: string | null };

const ownCode = (item: CodedItem, featureCode: (id: string) => string | null | undefined) =>
  codedTitle(item.title, null)[0] || inheritedCode(item, featureCode);

/** oracle.roadmap.codes.inherited: the code an item takes from its feature, else its PRD section; null when neither. */
export const inheritedCode = (
  item: CodedItem,
  featureCode: (id: string) => string | null | undefined,
): string | null =>
  (item.feature_id ? featureCode(item.feature_id) : null) || prdCode(item.section) || null;

/** changes._inherited: the code ``item`` takes from its feature or PRD section, null when its title gives it its own. */
export const takenFrom = (
  item: CodedItem,
  featureCode: (id: string) => string | null | undefined,
): string | null => (codedTitle(item.title, null)[0] ? null : inheritedCode(item, featureCode));
