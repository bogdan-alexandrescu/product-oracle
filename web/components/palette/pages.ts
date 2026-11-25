// build-palette (#1794): every page the palette goes to, read off each shell's own destinations
// (Simple's rail; Detailed's rail, its Settings, Company and Plan tabs), filtered as those are.
import { COMPANY_TABS } from '@/app/company/_tabs';
import { PLAN_TABS } from '@/app/plan/_tabs';
import { DESTINATIONS } from '@/components/ds/AppShell';
import { SIMPLE_DESTINATIONS } from '@/components/simple/SimpleShell';
import type { Operation } from '@/lib/me';
import { SETTINGS_TABS } from '@/lib/settings-tabs';

import type { Hit } from './hits';

type Place = { name: string; href: string };

/** The shell one is in lists its pages (the empty box); `more` are found by typing their name. */
export type Pages = { own: Hit[]; more: Hit[] };

export function palettePages(
  simple: boolean,
  rights: { can: (op: Operation) => boolean; simpleMode: boolean },
): Pages {
  const { can, simpleMode } = rights;
  const hit = (shell: string) => (p: Place) => ({
    key: `p-${p.href}`,
    kind: 'Page' as const,
    name: p.name,
    where: shell,
    href: p.href,
  });
  const settings = SETTINGS_TABS.filter((t) => can(t.read));
  const inSimple = simpleMode
    ? SIMPLE_DESTINATIONS.map((d) => ({ name: d.label, href: d.href })).map(hit('Simple'))
    : [];
  // As Detailed's rail: Settings opens on the first tab the person can read.
  const rail = [
    ...DESTINATIONS.map((d) => ({ name: d.label, href: d.href })),
    ...(settings[0] ? [{ name: 'Settings', href: settings[0].href }] : []),
  ].map(hit('Detailed'));
  const tabs = [
    ...PLAN_TABS.slice(1).map((t) => hit('Plan')({ name: t.name ?? t.label, href: t.href })),
    ...COMPANY_TABS.filter((t) => !t.read || can(t.read)).map((t) =>
      hit('Company')({ name: t.label, href: t.href }),
    ),
    ...settings.map((t) => hit('Settings')({ name: t.label, href: t.href })),
    hit('Detailed')({ name: 'My account', href: '/account' }),
  ];
  const [own, other] = simple ? [inSimple, rail] : [rail, inSimple];
  // A page both shells have by one name is the one of the shell one is in.
  const names = new Set(own.map((p) => p.name));
  return { own, more: [...other.filter((p) => !names.has(p.name)), ...tabs] };
}
