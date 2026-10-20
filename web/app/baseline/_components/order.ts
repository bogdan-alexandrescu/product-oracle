import type { EntityOut } from "@/lib/api/client";

/** The Baseline's tie-break: entities of equal weight sort by title. Home sorts goals the same way. */
export const byTitle = (a: Pick<EntityOut, "title">, b: Pick<EntityOut, "title">) => a.title.localeCompare(b.title);
