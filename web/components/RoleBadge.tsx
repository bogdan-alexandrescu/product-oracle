"use client";

import { Chip } from "@/components/ds/Chip";
import { useMe, type Operation } from "@/lib/me";

/**
 * qa-docs-22: one role marker with the same words on every Documents page. Only a role that
 * can do less than review is marked, by what can() lets it do: one that reads only sees View
 * only (#370), one that comments reads "Commenter: can comment". `also` names what else this
 * page lets it do (Quality: rate, save this check), each shown only when can() allows it.
 */
export function RoleBadge({ also = [] }: { also?: { op: Operation; words: string }[] }) {
  const { can, capsReady } = useMe();
  if (!capsReady || can("review_section")) return null;
  if (!can("create_comment")) {
    return (
      <Chip kind="na" data-testid="view-only" title="Your role in this company sets what you can do here">
        View only
      </Chip>
    );
  }
  const does = ["comment", ...also.filter((a) => can(a.op)).map((a) => a.words)];
  const list = does.length > 1 ? `${does.slice(0, -1).join(", ")} and ${does[does.length - 1]}` : does[0];
  return (
    <Chip kind="na" data-testid="role-badge" title="Your role in this company sets what you can do here">
      Commenter: can {list}
    </Chip>
  );
}
