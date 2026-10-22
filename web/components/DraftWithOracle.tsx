"use client";

import { useState } from "react";

import { NewRunDialog } from "@/app/runs/_new-run-dialog";
import { Button } from "@/components/ds";
import type { VersionSummary } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";

/** #255: a PRD whose latest version is still its template's skeleton is drafted before it is published. */
export function isTemplateOnly(kind: string | undefined, versions: VersionSummary[]): boolean {
  return kind === "prd" && !!versions.at(-1)?.notes?.some((x) => x.code === "template_only");
}

/** Draft with Oracle: the run dialog on Baseline to PRD, with this PRD filled in. */
export function DraftWithOracleButton({ slug }: { slug: string }) {
  const { role } = useMe();
  const [open, setOpen] = useState(false);
  if (!hasRole(role, "approver")) return null;
  return (
    <>
      <Button variant="primary" icon="doc" aria-haspopup="dialog" data-testid="draft-with-oracle" onClick={() => setOpen(true)}>
        Draft with Oracle
      </Button>
      {open && <NewRunDialog onClose={() => setOpen(false)} start={{ flow: "baseline_to_prd", document: slug, title: "Draft with Oracle" }} />}
    </>
  );
}
