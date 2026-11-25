'use client';
// inbox-ux (#1741): the Plan header's at-risk count names what it counts (items, not tracks) and
// opens the items it counts; picking one selects its row. The count is the API's (plan.service:
// items at risk or slipped, whose risk reads the one stale rule, roadmap.staleness.is_stale).

import { Button } from '@/components/ds';
import { Menu } from '@/components/review/parts';

import type { PlanItem } from './_lib';

const RISKY = new Set<PlanItem['state']>(['at_risk', 'slipped']);

export function AtRiskItems({
  count,
  items,
  onSelect,
}: {
  count: number;
  items: PlanItem[];
  onSelect: (id: string) => void;
}) {
  const risky = items.filter((i) => RISKY.has(i.state));
  return (
    <span data-testid="plan-count-at-risk">
      <Menu label={`${count} ${count === 1 ? 'item' : 'items'} at risk`} align="start">
        {(close) => (
          <span className="flex max-h-80 min-w-56 flex-col gap-1 overflow-auto" role="menu">
            {risky.map((i) => (
              <Button
                key={i.id}
                variant="ghost"
                role="menuitem"
                className="justify-start"
                onClick={() => {
                  close();
                  onSelect(i.id);
                  document
                    .querySelector(`[data-testid="plan-row"][data-id="${i.id}"]`)
                    ?.scrollIntoView({ block: 'center' });
                }}
              >
                {i.code ? `${i.code} ${i.title}` : i.title}
              </Button>
            ))}
          </span>
        )}
      </Menu>
    </span>
  );
}
