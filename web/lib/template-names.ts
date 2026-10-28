"use client";

import { api, unwrap } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

/*
 * Templates and themes by their names ("Goal-traced PRD", "Clean document"), never their keys
 * ("oracle-default", "clean-document"). Archived ones are included, so an older document's
 * template still has its name.
 */

/** A key in words, while the names load or for a key no list has: "clean-document" is "Clean document". */
export function keyWords(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type TemplateNames = {
  /** The template's name; null for no template. */
  template: (key: string | null | undefined) => string | null;
  /** The theme's name; null for no theme. */
  theme: (key: string | null | undefined) => string | null;
};

async function loadNames(): Promise<{ templates: Map<string, string>; themes: Map<string, string> }> {
  const [templates, themes] = await Promise.all([
    unwrap(api.GET("/v1/templates", { params: { query: { include_archived: true } } })).catch(() => []),
    unwrap(api.GET("/v1/themes", { params: { query: { include_archived: true } } })).catch(() => []),
  ]);
  return {
    templates: new Map(templates.map((t) => [t.key, t.name])),
    themes: new Map(themes.map((t) => [t.key, t.name])),
  };
}

/** Names of templates and themes, by key; a key reads in words until the names arrive. */
export function useTemplateNames(): TemplateNames {
  const q = useQuery("template-names", loadNames);
  return {
    template: (key) => (key ? (q.data?.templates.get(key) ?? keyWords(key)) : null),
    theme: (key) => (key ? (q.data?.themes.get(key) ?? keyWords(key)) : null),
  };
}
