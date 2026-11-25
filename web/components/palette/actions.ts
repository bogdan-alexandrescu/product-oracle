// build-palette (#1794), CP2 b: what the palette does (New item, New PRD, Ask Oracle) and a
// feature's own actions (Tab), as rows. Roles come through can() only (`Rights`).
import { askWith } from '@/components/hop/open-state';

import { newTitle } from './groups';

import type { Hit } from './hits';

export type Rights = { proposes: boolean; decides: boolean; edits: boolean; startsPrd: boolean };

export function actionsFor(
  words: string,
  { proposes, decides, startsPrd }: Rights,
  run: { newItem: (title: string, add: boolean) => void; newPrd: () => void },
): Hit[] {
  const typed = newTitle(words);
  const title = typed.title;
  // One who may add nothing has no "new …": the words are a plain search.
  const typedNew = typed.typedNew && proposes;
  const itemWord = decides ? 'New item' : 'Propose a new item';
  const out: Hit[] = [];
  if (proposes)
    out.push({
      key: 'a-item',
      kind: 'Action',
      name: typedNew && title ? `${itemWord}: ${title}` : itemWord,
      where: decides ? 'Roadmap · last track used' : 'Roadmap · an approver decides',
      // Added at once only by "new …": a search's words wait in the add box.
      run: () => run.newItem(title, typedNew && decides && !!title),
    });
  if (startsPrd)
    out.push({ key: 'a-prd', kind: 'Action', name: 'New PRD', where: 'Home', run: run.newPrd });
  out.push({
    key: 'a-ask',
    kind: 'Action',
    name: words && !typedNew ? `Ask Oracle: ${words}` : 'Ask Oracle',
    where: 'Opens beside the page',
    run: () => askWith(typedNew ? '' : words),
  });
  return out;
}

/** Tab on a feature: its own actions. */
export function featureActions(h: Hit, onPanel: (h: Hit, onRoadmap?: boolean) => void): Hit[] {
  return [
    {
      key: 'x-open',
      kind: 'Action',
      name: 'Open its panel',
      where: 'Here, over this page',
      run: () => onPanel(h),
    },
    {
      key: 'x-road',
      kind: 'Action',
      name: 'Show it on the Roadmap',
      where: 'Roadmap',
      run: () => onPanel(h, true),
    },
    {
      key: 'x-ask',
      kind: 'Action',
      name: `Ask Oracle about ${h.code} ${h.name}`,
      where: 'Opens beside the page',
      run: () => askWith(`Tell me about ${h.code} ${h.name}`),
    },
  ];
}

export function roleLineOf({ proposes, edits }: Rights): string {
  if (!proposes) return 'As a viewer you can find and open anything; you cannot add or change.';
  if (!edits) return 'As a commenter you can open any panel and propose changes there.';
  return '';
}
