import type { Metadata } from "next";

import { Empty, LinkButton, Page, PageHeader, Panel } from "@/components/ds";
import { SectionBackLink } from "@/components/SectionBackLink";

export const metadata: Metadata = {
  title: "Page not found · Product Oracle",
};

/**
 * A wrong URL (qa-shell-3), in the app's own page: the title, one sentence, Go to Home (the
 * bare URL, which opens the person's own home, Simple's or Detailed's) and,
 * under a known section, a link back to its list. No viewport-high box (qa-shell-25): on a
 * phone the page fits under the header without scrolling.
 */
export default function NotFound() {
  return (
    <Page>
      <PageHeader title="Page not found" />
      <Panel testId="not-found" bodyClassName="flex flex-col items-center gap-3 px-4 pb-8">
        <Empty icon="search">This page doesn&apos;t exist or has moved.</Empty>
        <div className="flex flex-wrap justify-center gap-2">
          <LinkButton href="/" variant="primary" icon="home">
            Go to Home
          </LinkButton>
          <SectionBackLink />
        </div>
      </Panel>
    </Page>
  );
}
