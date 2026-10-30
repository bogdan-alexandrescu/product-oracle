"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button, PageHeader, ViewOnly } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import type { Query } from "@/lib/use-query";

import { InterviewDialog } from "./InterviewDialog";
import { NewRequestButton } from "./NewRequest";
import { ClassifyNow, DailyTriageSwitch, TriageMenu, TriageStatusLine } from "./Triage";

/** On a phone the actions take the screen's width (qa-work-39): the Page's 10 px sides off it. */
const ACTIONS = "flex flex-wrap items-center justify-end gap-2 max-[600px]:w-[calc(100vw-1.25rem)] max-[600px]:flex-nowrap";

const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

/**
 * The header of every Requests tab (All requests, To decide, Themes, Interviews): the same
 * title, status line and actions on each (qa-work-41), so the tabs under it never move
 * (qa-shell-33). Auto-sort, one control holding the daily switch and Sort now (rirs-35;
 * approvers and owners, others see its state), then the two primary actions: Interview a
 * customer (C3, commenters and up) and New request (#329). #370:
 * each control shows only to a role that can use it; a role that can file nothing reads View only.
 * qa-shell-26: on a phone New request is the one button; Interview a customer and the
 * automatic sorting go under More, so three full-width buttons never stack.
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
  const phone = useIsPhone();
  const canChange = can("set_request_triage_daily");
  const canStart = can("start_request_triage");
  const canInterview = can("create_interview");
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
              {phone && (canChange || canStart || canInterview) ? (
                <PhoneMore>
                  {canInterview && (
                    <Button className="h-11 w-full" onClick={() => setInterviewing(true)}>
                      Interview a customer
                    </Button>
                  )}
                  {canChange || canStart ? (
                    <div role="group" aria-label="Sort new requests automatically" data-testid="triage-menu-panel" className="flex flex-col gap-3">
                      {canChange && <DailyTriageSwitch triage={triage} canChange />}
                      {canStart && <ClassifyNow triage={triage} />}
                    </div>
                  ) : (
                    // A commenter reads its state, as on a desktop.
                    <TriageMenu triage={triage} canChange={false} canStart={false} />
                  )}
                </PhoneMore>
              ) : (
                <>
                  <TriageMenu triage={triage} canChange={canChange} canStart={canStart} />
                  {canInterview && <Button onClick={() => setInterviewing(true)}>Interview a customer</Button>}
                </>
              )}
              <NewRequestButton onFiled={onFiled} className="max-[600px]:h-11 max-[600px]:flex-1" fromAddress />
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

/** The phone's More: the header's other actions in one panel under a single button (qa-shell-26). */
function PhoneMore({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>("[data-requests-more]")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div ref={root} className="relative order-last">
      <Button
        data-requests-more=""
        data-testid="requests-more"
        icon="more"
        className="h-11"
        aria-expanded={open}
        aria-controls="requests-more-panel"
        onClick={() => setOpen((o) => !o)}
      >
        More
      </Button>
      {open && (
        <div
          id="requests-more-panel"
          role="group"
          aria-label="More request actions"
          data-testid="requests-more-panel"
          className="absolute top-full right-0 z-30 mt-2 flex w-[calc(100vw-1.25rem)] flex-col gap-3 rounded-panel border border-line bg-surface p-3 text-left shadow-tip"
        >
          {children}
        </div>
      )}
    </div>
  );
}
