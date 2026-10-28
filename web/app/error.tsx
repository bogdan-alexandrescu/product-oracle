"use client";

import { useEffect } from "react";

import { Button, Empty, LinkButton, Page, PageHeader, Panel } from "@/components/ds";

/** A page that failed to render, in the app's own page: what happened, Try again and Go to Home. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Page>
      <PageHeader title="Something went wrong" />
      <Panel testId="app-error" bodyClassName="flex flex-col items-center gap-3 px-4 pb-8">
        <Empty icon="alert">Something went wrong.</Empty>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <LinkButton href="/" variant="secondary" icon="home" className="h-10">
            Go to Home
          </LinkButton>
        </div>
      </Panel>
    </Page>
  );
}
