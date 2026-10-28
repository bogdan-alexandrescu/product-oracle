"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { LinkButton } from "@/components/ds";

/** The sections a wrong URL may sit under, and their lists. */
const SECTIONS = [
  { prefix: "/settings", href: "/settings", label: "Settings" },
  { prefix: "/company", href: "/company", label: "Company" },
  { prefix: "/plan", href: "/plan", label: "Plan" },
  { prefix: "/documents", href: "/documents", label: "PRDs" },
  { prefix: "/runs", href: "/runs", label: "Runs" },
] as const;

const noop = () => () => {};

/**
 * The not-found page's "Back to Settings" (qa-shell-3): a link to the list of the section
 * the wrong URL is under. Drawn only once hydrated, so the server and the client render the
 * same markup whatever pathname the server saw for a not-found (qa-shell-24).
 */
export function SectionBackLink() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  if (!hydrated || !pathname) return null;
  const section = SECTIONS.find((s) => pathname === s.prefix || pathname.startsWith(`${s.prefix}/`));
  if (!section) return null;
  return (
    <LinkButton href={section.href} variant="secondary" icon="back" data-testid="not-found-back" className="h-10">
      Back to {section.label}
    </LinkButton>
  );
}
