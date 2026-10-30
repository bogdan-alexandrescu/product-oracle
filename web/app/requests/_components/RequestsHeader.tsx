"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button, PageHeader, ViewOnly } from "@/components/ds";
import type { Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import type { Query } from "@/lib/use-query";

import { InterviewDialog } from "./InterviewDialog";
import { NewRequestButton } from "./NewRequest";
import { TriageMenu, TriageStatusLine } from "./Triage";

/** On a phone the actions take the screen's width (the Page's 10 px sides off it): New request, then More (qa-work-41). */
const ACTIONS = "flex flex-wrap items-center justify-end gap-2 max-[600px]:w-[calc(100vw-1.25rem)] max-[600px]:flex-nowrap";

/** The phone's width, as the app's max-[600px] styles read it. */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(max-width: 600px)");
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

/** The phone's More menu (qa-work-41): the header's other actions, under one button beside New request. */
function MoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The Auto-sort panel inside closes first on its own Escape.
      if (e.key !== "Escape" || root.current?.querySelector("[data-testid=triage-menu-panel]")) return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>("[data-more-button]")?.focus();
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
    <div ref={root} className="relative flex-none">
      <Button
        data-more-button=""
        data-testid="requests-more"
        variant="secondary"
        className="h-11"
        aria-haspopup="true"
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
          aria-label="More actions"
          data-testid="requests-more-panel"
          className="absolute top-full right-0 z-30 mt-2 flex w-[calc(100vw-1.25rem)] flex-col items-stretch gap-2 rounded-panel border border-line bg-surface p-3 shadow-tip"
          onClick={(e) => {
            // A chosen action (Interview a customer) closes the menu; the Auto-sort control keeps it open.
            if ((e.target as HTMLElement).closest("[data-closes-more]")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
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
  const phone = usePhoneWidth();
  const canChange = can("set_request_triage_daily");
  const canStart = can("start_request_triage");
  const triageMenu = <TriageMenu triage={triage} canChange={canChange} canStart={canStart} />;
  const interview = can("create_interview") && (
    <Button data-closes-more="" className="max-[600px]:h-11" onClick={() => setInterviewing(true)}>
      Interview a customer
    </Button>
  );
  // qa-work-41: on a phone one primary button (New request) shows; the rest sit under More.
  // Auto-sort's state alone (no switch for this role) stays a chip beside it.
  const more = phone && (canChange || canStart || !!interview);
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
              {more ? (
                <>
                  {!canChange && !canStart && triageMenu}
                  <NewRequestButton onFiled={onFiled} className="h-11 min-w-0 flex-1" fromAddress />
                  <MoreMenu>
                    {(canChange || canStart) && triageMenu}
                    {interview}
                  </MoreMenu>
                </>
              ) : (
                <>
                  {triageMenu}
                  {interview}
                  <NewRequestButton onFiled={onFiled} className="max-[600px]:h-11 max-[600px]:flex-1" fromAddress />
                </>
              )}
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

