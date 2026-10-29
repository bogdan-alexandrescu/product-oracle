"use client";

import { useState } from "react";

import { Button, PageHeader, ViewOnly } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import type { Query } from "@/lib/use-query";

import { InterviewDialog } from "./InterviewDialog";
import { NewRequestButton } from "./NewRequest";
import { TriageMenu, TriageStatusLine } from "./Triage";

/** On a phone the actions stack full width, one per line (qa-work-39): the Page's 10 px sides off the screen's width. */
const ACTIONS =
  "flex flex-wrap items-center justify-end gap-2 max-[600px]:w-[calc(100vw-1.25rem)] max-[600px]:flex-col max-[600px]:items-stretch";

/**
 * The header of every Requests tab (All requests, To decide, Themes, Interviews): the same
 * title, status line and actions on each (qa-work-41), so the tabs under it never move
 * (qa-shell-33). Auto-sort, one control holding the daily switch and Sort now (rirs-35;
 * approvers and owners, others see its state), then the two primary actions: Interview a
 * customer (C3, commenters and up) and New request (#329). #370:
 * each control shows only to a role that can use it; a role that can file nothing reads View only.
 */
export function RequestsHeader({
  triage,
  onFiled,
  onInterviewed,
}: {
  triage: Query<Schemas["TriageStatus"]>;
  onFiled: (request: Schemas["RequestOut"]) => void;
  /** An interview was made or changed in the dialog (the Interviews tab re-reads its list). */
  onInterviewed?: () => void;
}) {
  const { can, capsReady } = useMe();
  const [interviewing, setInterviewing] = useState(false);
  return (
    <>
      <PageHeader
        title="Requests"
        testId="requests-header"
        status={
          <>
            {capsReady && !can("create_request", true) && <ViewOnly />}
            <TriageStatusLine status={triage.data} />
          </>
        }
        action={
          capsReady && (
            <div data-testid="requests-actions" className={ACTIONS}>
              <TriageMenu triage={triage} canChange={can("set_request_triage_daily")} canStart={can("start_request_triage")} />
              {can("create_interview") && (
                <Button className="max-[600px]:h-11" onClick={() => setInterviewing(true)}>
                  Interview a customer
                </Button>
              )}
              <NewRequestButton onFiled={onFiled} className="max-[600px]:h-11" />
            </div>
          )
        }
      />
      {interviewing && (
        <InterviewDialog
          onClose={() => {
            setInterviewing(false);
            onInterviewed?.();
          }}
          onChanged={onInterviewed}
        />
      )}
    </>
  );
}
