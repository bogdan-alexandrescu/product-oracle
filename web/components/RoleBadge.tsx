"use client";

import { Chip } from "@/components/ds/Chip";
import { useMe } from "@/lib/me";

/**
 * qa-docs-22: one role marker with the same words on every Documents page. Only a role that
 * can do less than write is marked: a viewer reads (View only, #370), a commenter reads and comments.
 */
const WORDS: Partial<Record<string, string>> = {
  viewer: "View only",
  commenter: "Commenter: can comment",
};

export function RoleBadge() {
  const { role } = useMe();
  const words = role ? WORDS[role] : undefined;
  if (!words) return null;
  return (
    <Chip kind="na" data-testid={role === "viewer" ? "view-only" : "role-badge"} title="Your role in this company sets what you can do here">
      {words}
    </Chip>
  );
}
