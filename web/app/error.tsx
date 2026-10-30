"use client";

import { useEffect } from "react";

import { Button, LinkButton, NotFoundPanel } from "@/components/ds";

/**
 * A page that failed to render (qa-shell-9), in the app's one not-found pattern: one heading,
 * what happened and that saved work is kept, Try again and Go to Home, and the error's
 * reference (Next's digest) to quote to support.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <NotFoundPanel
      title="Something went wrong"
      icon="alert"
      testId="app-error"
      home={false}
      actions={
        <>
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <LinkButton href="/" variant="secondary" icon="home" className="h-10">
            Go to Home
          </LinkButton>
        </>
      }
    >
      {/* A digest means the server failed; without one, the page failed in this browser. */}
      <p data-testid="app-error-text">
        {error.digest
          ? "This page couldn't be shown because of a problem on our side. Everything you saved is kept."
          : "This page stopped working in your browser. Everything you saved is kept; try again, or reload the page."}
      </p>
      {error.digest && (
        <p data-testid="app-error-reference" className="text-sm">
          If it happens again, tell support this reference: <span className="font-semibold text-text">{error.digest}</span>
        </p>
      )}
    </NotFoundPanel>
  );
}
