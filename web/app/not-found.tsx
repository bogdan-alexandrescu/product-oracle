import type { Metadata } from "next";

import { LinkButton, NotFoundPanel } from "@/components/ds";
import { SectionBackLink } from "@/components/SectionBackLink";

export const metadata: Metadata = {
  title: "Page not found · Product Oracle",
};

/**
 * A wrong URL (qa-shell-3), in the app's one not-found pattern (NotFoundPanel, qa-shell-8):
 * the title, one sentence, Go to Home (the bare URL, which opens the person's own home,
 * Simple's or Detailed's) and, under a known section, a link back to its list. No
 * viewport-high box (qa-shell-25): on a phone the page fits under the header without scrolling.
 */
export default function NotFound() {
  return (
    <NotFoundPanel
      title="Page not found"
      testId="not-found"
      home={false}
      actions={
        <>
          <LinkButton href="/" variant="primary" icon="home">
            Go to Home
          </LinkButton>
          <SectionBackLink />
        </>
      }
    >
      <p>This page doesn&apos;t exist or has moved.</p>
    </NotFoundPanel>
  );
}
