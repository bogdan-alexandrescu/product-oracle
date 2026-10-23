"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import type { Schemas } from "@/lib/api/client";

/**
 * What is on screen, for the head-of-product panel (G7, 3.3): a discussion subject and its
 * label. A page that says nothing is `{kind: "screen", subject: {path}}`, labelled by its page.
 */
export type ScreenSubject = { kind: Schemas["DiscussionCreate"]["subject_kind"]; subject: Record<string, unknown>; label: string };

/** The panel's General chat (G7 3.1). */
export const GENERAL: ScreenSubject = { kind: "screen", subject: { path: "/" }, label: "General" };

/** By first path segment, as the API names them (oracle.discussions.context.page_name). */
const PAGES: Record<string, string> = {
  home: "Home",
  requests: "Requests",
  baseline: "Baseline",
  documents: "PRDs",
  priorities: "Priorities",
  plan: "Plan",
  roadmap: "Plan",
  runs: "Runs",
  inbox: "Inbox",
  company: "Company",
  sources: "Sources",
  settings: "Settings",
};

/** "Settings · Members" for /settings/members, "General" for /. */
export function pageName(path: string): string {
  const parts = path.split("?")[0].split("/").filter(Boolean);
  if (parts.length === 0) return "General";
  const name = PAGES[parts[0]];
  if (!name) return path;
  if ((parts[0] === "settings" || parts[0] === "company") && parts[1]) {
    const tab = parts[1].replace(/-/g, " ");
    return `${name} · ${tab[0].toUpperCase()}${tab.slice(1)}`;
  }
  return name;
}

/** A discussion subject's lookup key (oracle.discussions.service.subject_key). */
export function subjectKey(s: ScreenSubject): string | null {
  const v = s.subject as Record<string, string | undefined>;
  switch (s.kind) {
    case "screen":
      return `screen:${v.path}`;
    case "document":
      return `document:${v.document_id}`;
    case "section":
      return `section:${v.document_id}:${v.section_key}`;
    case "entity":
      return `entity:${v.entity_id}`;
    case "track":
      return `track:${v.track_id}`;
    case "priorities":
      return "priorities";
    default:
      return null; // a checkpoint's key needs its kind; the panel lists by run instead
  }
}

type Held = { path: string; value: ScreenSubject } | null;
const Ctx = createContext<{ set: Held; put: Dispatch<SetStateAction<Held>> } | null>(null);

export function ScreenSubjectProvider({ children }: { children: ReactNode }) {
  const [set, put] = useState<Held>(null);
  const value = useMemo(() => ({ set, put }), [set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * A page says what it shows (G7 3.3): `subject` null keeps the page's own `screen` subject.
 * Cleared when the page goes.
 */
export function useScreenSubject(subject: Pick<ScreenSubject, "kind" | "subject"> | null, label: string | null | undefined) {
  const ctx = useContext(Ctx);
  const pathname = usePathname();
  const put = ctx?.put;
  const key = subject && label ? JSON.stringify([subject.kind, subject.subject, label]) : null;
  useEffect(() => {
    if (!put) return;
    if (!key) return;
    const [kind, value, text] = JSON.parse(key) as [ScreenSubject["kind"], Record<string, unknown>, string];
    const mine: Held = { path: pathname, value: { kind, subject: value, label: text } };
    put(mine);
    // Only this page's own subject is cleared: a hidden route (Next keeps recent ones mounted) never clears the next page's.
    return () => put((now) => (now === mine ? null : now));
  }, [put, key, pathname]);
}

/** What is on screen now: the page's subject, else its `screen` subject. */
export function useCurrentScreenSubject(): ScreenSubject {
  const ctx = useContext(Ctx);
  const pathname = usePathname();
  if (ctx?.set && ctx.set.path === pathname) return ctx.set.value;
  return { kind: "screen", subject: { path: pathname }, label: pageName(pathname) };
}
