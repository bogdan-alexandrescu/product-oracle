// MOCK-HOOK (whole file): mk-inbox-keys mock-ups only. Invented company (Brightwell Kitchens), people and features.
import type { IconName } from '@/components/ds'; // MOCK-HOOK

export type IkItem = { // MOCK-HOOK
  id: string;
  kind: string;
  icon: IconName;
  title: string;
  code?: string;
  ctx: string;
  age: string;
  /** The row's main action, said on its button. */
  main: 'Approve' | 'Accept' | 'Review' | 'Answer';
  /** What the main action did, said in the banner. */
  did: string;
  decline: boolean;
  /** Only an owner or approver decides it. */
  ownerOnly: boolean;
  detail: string;
  /** Seen already (the Seen tab). */
  seen?: boolean;
}; // MOCK-HOOK

const base: IkItem[] = [ // MOCK-HOOK
  { id: 'i1', kind: 'Checkpoint', icon: 'flag', title: 'Confirm the Ground Truth: approve to continue', ctx: 'Ground Truth proposal · Pantry sync', age: '2d', main: 'Review', did: 'Opened for review', decline: false, ownerOnly: true, detail: 'Oracle drafted 4 goals and 11 features for Pantry sync. Approve to write the PRD.' },
  { id: 'i2', kind: 'Cost approval', icon: 'coin', title: 'Start run · $38.00 est.', ctx: 'Meal plan export PRD · Ground Truth to PRD', age: '2d', main: 'Approve', did: 'Approved: run started', decline: true, ownerOnly: true, detail: 'Estimated $38.00, over the $30 approval threshold.' },
  { id: 'i3', kind: 'Proposal', icon: 'pencil', title: 'Move delivery to Feb 12', code: 'F-41', ctx: 'From Noor Haddad · Recipe cards', age: '1d', main: 'Accept', did: 'Accepted: it is in your working draft', decline: true, ownerOnly: true, detail: 'Noor suggests Feb 12, 2027 for F-41 Recipe cards: the print vendor needs two more weeks.' },
  { id: 'i4', kind: 'Question', icon: 'ask', title: 'Should Grocery list share work offline?', ctx: 'Asked by Teo Lindqvist · Grocery list share', age: '1d', main: 'Answer', did: 'Answered', decline: false, ownerOnly: false, detail: 'Teo asks: the app shows the list on a train with no signal. Do we keep edits until it is back?' },
  { id: 'i5', kind: 'Access request', icon: 'user', title: 'jun.arakawa@example.com asks to join', ctx: '"I run the test kitchen and need the roadmap."', age: '20h', main: 'Approve', did: 'Approved: Jun can sign in', decline: true, ownerOnly: true, detail: 'Jun Arakawa asks to join as a Commenter.' },
  { id: 'i6', kind: 'Dates', icon: 'clock', title: 'Oracle suggests Mar 2 – Apr 10, 2027', code: 'F-44', ctx: 'Smart oven timers', age: '9h', main: 'Accept', did: 'Accepted: dates set', decline: true, ownerOnly: true, detail: 'It starts after F-41 Recipe cards and runs 39 days, like 2 similar items.' },
  { id: 'i7', kind: 'Review reminder', icon: 'doc', title: 'Review the draft of Pantry sync PRD', ctx: 'Nudged by Sol Benitez', age: '6h', main: 'Review', did: 'Opened for review', decline: false, ownerOnly: false, detail: 'Sol asks you to read sections 2 and 3 before Thursday.' },
  { id: 'i8', kind: 'Feedback', icon: 'comment', title: '"The shopping total should show tax"', code: 'F-47', ctx: 'From Mara Okonkwo · Checkout totals', age: '4h', main: 'Accept', did: 'Accepted: it is in your working draft', decline: true, ownerOnly: false, detail: 'Mara: shoppers in two states asked why the total changes at the till.' },
  { id: 'i9', kind: 'Dates', icon: 'clock', title: 'Oracle suggests Apr 5 – May 14, 2027', code: 'F-48', ctx: 'Leftovers planner', age: '3h', main: 'Accept', did: 'Accepted: dates set', decline: true, ownerOnly: true, detail: 'It starts with the Later window (Apr 5) and runs 39 days.' },
  { id: 'i10', kind: 'Proposal', icon: 'pencil', title: 'Link to goal "Fewer wasted groceries"', code: 'F-50', ctx: 'From Priya Raman · Use-by alerts', age: '2h', main: 'Accept', did: 'Accepted: it is in your working draft', decline: true, ownerOnly: true, detail: 'Priya links F-50 Use-by alerts to the goal it serves.' },
  { id: 'i11', kind: 'Question', icon: 'ask', title: 'Who signs off the new pantry icons?', ctx: 'Asked by Ines Moreau · Pantry sync', age: '1h', main: 'Answer', did: 'Answered', decline: false, ownerOnly: false, detail: 'Ines needs one name before the design review.' },
  { id: 'i12', kind: 'Feedback', icon: 'comment', title: '"Let me reorder steps in a recipe"', code: 'F-52', ctx: 'From Kofi Mensah · Recipe editor', age: '40m', main: 'Accept', did: 'Accepted: it is in your working draft', decline: true, ownerOnly: false, detail: 'Kofi: cooks drag steps today by copying text.' },
  { id: 'i13', kind: 'Cost approval', icon: 'coin', title: 'Start run · $44.50 est.', ctx: 'Use-by alerts PRD · Feedback loop', age: '25m', main: 'Approve', did: 'Approved: run started', decline: true, ownerOnly: true, detail: 'Estimated $44.50, over the $30 approval threshold.' },
  { id: 'i14', kind: 'Review reminder', icon: 'doc', title: 'Review the draft of Recipe cards PRD', ctx: 'Nudged by Noor Haddad', age: '10m', main: 'Review', did: 'Opened for review', decline: false, ownerOnly: false, detail: 'Noor changed the print sizes; she asks for a look.' },
  { id: 's1', kind: 'Feedback', icon: 'comment', title: '"Dark mode for the kitchen tablet"', code: 'F-38', ctx: 'From Ada Wilkins · Kitchen tablet view', age: '1w', main: 'Accept', did: 'Accepted', decline: true, ownerOnly: false, detail: 'Ada: the screen is too bright at night service.', seen: true },
  { id: 's2', kind: 'Question', icon: 'ask', title: 'Do we keep the old meal plan link?', ctx: 'Asked by Ravi Kapoor · Meal plan export', age: '5d', main: 'Answer', did: 'Answered', decline: false, ownerOnly: false, detail: 'Ravi: 300 people bookmarked it.', seen: true },
  { id: 's3', kind: 'Dates', icon: 'clock', title: 'Oracle suggests Jan 11 – Feb 3, 2027', code: 'F-39', ctx: 'Barcode scan', age: '4d', main: 'Accept', did: 'Accepted: dates set', decline: true, ownerOnly: true, detail: 'It starts after F-38 Kitchen tablet view and runs 23 days.', seen: true },
]; // MOCK-HOOK

/** Long names (the hard case): the same rows with long titles and people names; a feature keeps its one name. MOCK-HOOK */
const LONG: Record<string, Partial<IkItem>> = { // MOCK-HOOK
  i1: { ctx: 'Ground Truth proposal · Pantry sync across every household member and their shared shopping lists' },
  i3: { title: 'Move delivery to Feb 12 and split printing with step photos into its own slice', ctx: 'From Noor Haddad-Villanueva · Recipe cards' },
  i4: { title: 'Should Grocery list share keep working offline on long train rides with no signal?', ctx: 'Asked by Teodor Lindqvist-Abernathy · Grocery list share' },
  i6: { title: 'Oracle suggests Mar 2 – Apr 10, 2027, after the print vendor slot and the holiday freeze' },
  i8: { title: '"The shopping total should show tax and the bottle deposit as their own lines"', ctx: 'From Mara Okonkwo-Fairweather · Checkout totals' },
}; // MOCK-HOOK

/** More of the same kind (many items): 30 more rows. MOCK-HOOK */
/** 30 names, each used once: one invented feature, one code. MOCK-HOOK */
const MANY_NAMES = ['Spice rack scan', 'Lunchbox planner', 'Allergen badges', 'Batch cooking mode', 'Pantry low alerts', 'Family accounts', 'Store price compare', 'Recipe import', 'Portion slider', 'Voice timers', 'Freezer log', 'Seasonal picks', 'Wine pairing tips', 'Kids cooking mode', 'Budget tracker', 'Herb garden notes', 'Party menu builder', 'Unit converter', 'Cookware list', 'Bread starter log', 'Picnic packs', 'Swap suggestions', 'Fridge photo scan', 'Meal prep timer', 'Snack ideas', 'Tea and coffee log', 'Baking scale', 'Grill guide', 'Soup of the week', 'Dinner rota']; // MOCK-HOOK

export function ikItems(opts: { long?: boolean; many?: boolean }): IkItem[] { // MOCK-HOOK
  let items = base.map((i) => (opts.long && LONG[i.id] ? { ...i, ...LONG[i.id] } : i));
  if (opts.many)
    items = [
      ...items,
      ...Array.from({ length: 30 }, (_, n): IkItem => ({
        id: `m${n}`,
        kind: n % 3 === 0 ? 'Feedback' : n % 3 === 1 ? 'Dates' : 'Proposal',
        icon: n % 3 === 0 ? 'comment' : n % 3 === 1 ? 'clock' : 'pencil',
        title: n % 3 === 0 ? `"Please add ${MANY_NAMES[n].toLowerCase()}"` : n % 3 === 1 ? 'Oracle suggests May 3 – Jun 1, 2027' : 'Move delivery a week later',
        code: `F-${60 + n}`,
        ctx: MANY_NAMES[n],
        age: `${n + 1}m`,
        main: 'Accept',
        did: 'Accepted',
        decline: true,
        ownerOnly: n % 3 !== 0,
        detail: 'An invented item for the long list.',
      })),
    ];
  return items;
} // MOCK-HOOK

/** Items already snoozed, with when they come back. MOCK-HOOK */
export const IK_SNOOZED: { item: IkItem; until: string; event?: string }[] = [ // MOCK-HOOK
  { item: { ...base[0], id: 'z1', kind: 'Feedback', icon: 'comment', title: '"Weekly menu should start on Sunday"', code: 'F-35', ctx: 'From Lena Fischer · Weekly menu email', age: '2w', main: 'Accept', did: 'Accepted', decline: true, ownerOnly: false }, until: 'Nov 25, 9:00 AM' },
  { item: { ...base[0], id: 'z2', kind: 'Proposal', icon: 'pencil', title: 'Drop the printed shopping list', code: 'F-33', ctx: 'From Ravi Kapoor · Printable lists', age: '1w', main: 'Accept', did: 'Accepted', decline: true, ownerOnly: true }, until: 'Nov 26, 10:00 AM', event: 'after Product sync, Nov 26' },
]; // MOCK-HOOK
