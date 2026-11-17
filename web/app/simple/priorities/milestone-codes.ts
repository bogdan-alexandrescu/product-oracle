import { api, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Read = Schemas["SimpleRoadmapOut"];

/** A name that already starts with its code ("M6 · Beta", "F-26: Keys"). */
const CODED = /^[A-Z][A-Z0-9]*-?\d+[a-z]?(\s|·|:|$)/;

/**
 * qa-nov17 G8: a milestone's code and name as the roadmap reads it ("M6 Beta"), so one milestone has one name on
 * Priorities, the Goal buckets and the Roadmap: by its id (a goal milestone or a dated one), else by its name (the
 * one the item is in first). Its name alone when the roadmap gives it no code, or two codes share the name.
 */
export function codedMilestone(read: Read | undefined, name: string, by: { id?: string | null; itemId?: string | null } = {}): string {
  if (CODED.test(name)) return name;
  if (!read) return name;
  const all: { id: string; name: string; code: string | null | undefined; item_ids: string[] }[] = [
    ...read.milestones.map((m) => ({ id: m.id, name: m.name, code: m.roadmap_code, item_ids: m.item_ids })),
    ...(read.goal_milestones ?? []).filter((m) => !m.goal_target).map((m) => ({ id: m.id, name: m.name, code: m.roadmap_code ?? m.code, item_ids: m.item_ids })),
  ];
  const byId = by.id ? all.find((m) => m.id === by.id) : undefined;
  const named = byId ? [byId] : all.filter((m) => m.name === name);
  const held = by.itemId ? named.filter((m) => m.item_ids.includes(by.itemId!)) : [];
  const codes = [...new Set((held.length ? held : named).map((m) => m.code).filter((c): c is string => !!c))];
  return codes.length === 1 ? `${codes[0]} ${name}` : name;
}

/** The page's coder: the roadmap's read (the one the buckets' tasks read, task-edit's useRoadmapItems) gives each milestone its code. */
export function useCodedMilestone(): (name: string, by?: { id?: string | null; itemId?: string | null }) => string {
  const read = useQuery("simple-roadmap:{}", async () => {
    const { data } = await api.GET("/v1/simple/roadmap", {});
    if (!data) throw new Error("Could not read the roadmap");
    return data;
  }).data;
  return (name, by) => codedMilestone(read, name, by);
}
