import { LinkButton, NotFoundPanel } from "@/components/ds";

/** What a document the API does not have says (404), without its slug (qa-shell-1). */
export const DOC_MISSING = "This document doesn't exist or was deleted.";

/**
 * A document that is not there (deleted, or an old link), on its overview and on its version
 * page alike: the app's one not-found pattern (qa-shell-8), "Document not found" as the H1 and
 * so the browser tab, and the way back to PRDs.
 */
export function DocumentNotFound() {
  return (
    <NotFoundPanel
      title="Document not found"
      icon="doc"
      testId="doc-not-found"
      actions={
        <LinkButton href="/documents" variant="primary" icon="back">
          Back to PRDs
        </LinkButton>
      }
    >
      <p>{DOC_MISSING}</p>
    </NotFoundPanel>
  );
}
