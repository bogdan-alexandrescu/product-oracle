"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { DeleteDialog } from "@/components/ArtifactMenu";
import { Button, Chip, confirmInPage, Icon, Notice, Page, PageHeader, Sheet, Split } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { Menu, TabBar } from "@/components/review/parts";
import { ApiError, api, unwrap } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useMe } from "@/lib/me";
import { invalidateWaiting, waitingChanged } from "@/lib/waiting";
import { errorMessage, useQuery } from "@/lib/use-query";

import { DraftSheet } from "./_draft-sheet";
import { FindingsTab } from "./_findings";
import { GapsTab } from "./_gaps";
import { IntakeInspector, readiness, readinessTitle } from "./_inspector";
import { OPEN_GAP, dayMonth, gateReason, statusChip, tally, unknownNote, type Batch, type Summary } from "./_lib";
import { ProposalsTab } from "./_proposals";
import { QuestionsTab } from "./_questions";
import { ReadLine } from "./_read";

const PHONE = "(max-width: 600px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/** Every batch asked so far, oldest first. */
async function loadBatches(intakeId: string, current: number | null | undefined): Promise<Batch[]> {
  const numbers = Array.from({ length: current ?? 0 }, (_, i) => i + 1);
  const batches = await Promise.all(
    numbers.map((n) => unwrap(api.GET("/v1/intakes/{intake_id}/question-batch", { params: { path: { intake_id: intakeId }, query: { batch: n } } }))),
  );
  return batches.filter((b) => b.questions.length > 0);
}

type Tab = "questions" | "gaps" | "proposals" | "findings";

/**
 * Before drafting (C5, B1 Split): what Oracle still needs to know about a brief, asked of
 * named people in short batches, and whether the PRD is ready to draft. Draft with Oracle
 * waits while a critical question is open (C5 "Draft gate", decided 2026-10-21): answer it,
 * or record a decision from the inspector.
 */
export function BeforeDrafting({ id }: { id: string }) {
  const { me, role, can } = useMe();
  const router = useRouter();
  const phone = useIsPhone();
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("questions");
  const [sheet, setSheet] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The question an inspector's Answer asked for: focused once the Questions tab shows it. */
  const [focusing, setFocusing] = useState<string | null>(null);

  useEffect(() => {
    if (!focusing || tab !== "questions") return;
    // The tab's panel renders after this commit (its list may still be loading): look for the
    // question on each frame until it is there, for at most two seconds.
    let frame = 0;
    let tries = 0;
    const find = () => {
      const li = document.getElementById(`q-${focusing}`);
      if (!li) {
        if (++tries < 120) frame = window.requestAnimationFrame(find);
        else setFocusing(null);
        return;
      }
      setFocusing(null);
      li.scrollIntoView({ block: "center" });
      const button = [...li.querySelectorAll<HTMLButtonElement>("button")].find((b) => ["Answer", "Change answer"].includes(b.textContent?.trim() ?? ""));
      if (button) return button.focus();
      // Asked of someone else: the question itself takes the focus.
      li.setAttribute("tabindex", "-1");
      li.focus();
    };
    frame = window.requestAnimationFrame(find);
    return () => window.cancelAnimationFrame(frame);
  }, [focusing, tab]);

  const summaryQ = useQuery(
    `intake|${id}|${version}`,
    // rirs-30: a brief that is gone (404) is told as such, not as an error.
    () =>
      unwrap(api.GET("/v1/intakes/{intake_id}/summary", { params: { path: { intake_id: id } } })).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }),
    { keepPrevious: true },
  );
  const gone = summaryQ.data === null;
  const s = summaryQ.data ?? undefined;
  const batchesQ = useQuery(`intake|${id}|batches|${version}|${s?.batch.current ?? ""}`, () => loadBatches(id, s?.batch.current), { keepPrevious: true });
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      changed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Archive asks first; the page shows the archived brief at once, before the summary is read again. */
  async function archive() {
    if (!s) return;
    const lock = s.intake.lock_version;
    if (!(await confirmInPage({ action: "Archive", message: "Archive this brief? It leaves PRDs › Ideas and Oracle stops asking its questions." }))) return;
    await act(async () => {
      const intake = await unwrap(api.PATCH("/v1/intakes/{item_id}", { params: { path: { item_id: id } }, body: { status: "archived", lock_version: lock } }));
      summaryQ.setData((prev) => prev && { ...prev, intake });
      // Its questions are retired: the Inbox badge counts them no more.
      invalidateWaiting();
    });
    waitingChanged();
  }

  if (gone) {
    return (
      <Page>
        <PageHeader back={<BackToPrds />} title="This brief is not here" />
        <div data-testid="intake-gone" className="flex flex-col items-start gap-3 rounded-panel border border-line bg-surface p-4 shadow-panel">
          <p className="text-[15px] text-text">
            It may have been drafted into a PRD, archived, or deleted. A drafted brief lives on as its PRD; a deleted one waits in Trash for a while.
          </p>
          <Link href="/documents" className="font-semibold text-accent-ink underline">
            Back to PRDs
          </Link>
        </div>
      </Page>
    );
  }
  if (!s) {
    return <Page>{summaryQ.error ? <ErrorNote>{summaryQ.error}</ErrorNote> : <Loading />}</Page>;
  }

  const gate = s.readiness;
  const blocked = gate.gate === "blocked";
  const author = s.intake.author_id === me?.user_id;
  // #370: what the controls call. Drafting is an approver's (start_intake_run); archiving
  // is the author's or an approver's (the handler's author_or); Re-analyse, Pin new
  // sources and Oracle's read (Read again) are the author's only.
  const mayDraft = can("start_intake_run");
  const mayArchive = can("update_intake", author || mayDraft);
  const mayAnalyze = author && can("analyze_intake");
  const mayRepin = author && can("repin_intake");
  const mayRead = author && can("start_intake_read");
  // #482: owners delete a brief (and the PRD it became) to Trash.
  const mayDelete = can("delete_intake");
  const converted = s.intake.status === "converted";
  const archived = s.intake.status === "archived";
  const reason = blocked ? gateReason(gate.blocking_gap_ids.length, gate.open_critical) : null;
  // qa-work-2: the chip and the counts read one tally of the asked questions.
  const status = statusChip(s, tally(s, batchesQ.data ?? undefined));
  const openGaps = s.gaps.filter((g) => OPEN_GAP.has(g.status)).length;
  const fresh = s.new_evidence.visible ? (s.new_evidence.count ?? 0) : 0;

  // qa-docs-19: an open critical question in the inspector opens its bubble in the thread.
  // The gap's newest question still open (asked or delegated), else its newest: an older,
  // answered one is not what Answer is for.
  const questionFor = (gapId: string) => {
    const asked = (batchesQ.data ?? []).flatMap((b) => b.questions.map((c) => c.question)).filter((q) => q.gap_id === gapId);
    const newest = [...asked].reverse();
    return (newest.find((q) => q.status === "asked" || q.status === "delegated") ?? newest[0])?.id ?? null;
  };
  const answer = (questionId: string) => {
    setSheet(false);
    setTab("questions");
    setFocusing(questionId);
  };
  const inspector = (
    <IntakeInspector
      summary={s}
      batches={batchesQ.data ?? undefined}
      role={role}
      onChanged={changed}
      questionFor={questionFor}
      onAnswer={answer}
    />
  );
  // qa-work-11 / qa-docs-65: one overflow menu holds every lesser action, Delete… last.
  const live = !converted;
  const more = ((live && (mayAnalyze || mayRepin || (mayArchive && !archived))) || mayDelete) && (
    <Menu label={`Actions for ${s.intake.title}`} icon="more" iconOnly>
      {(close) => (
        <div className="flex min-w-48 flex-col gap-1" role="menu">
          {live && mayAnalyze && (
            <Button variant="ghost" role="menuitem" className="justify-start" disabled={busy} onClick={() => (close(), act(() => unwrap(api.POST("/v1/intakes/{intake_id}/analyze", { params: { path: { intake_id: id } } }))))}>
              {/* rirs-29: what it does, unlike the read line's "Read the brief again". */}
              Rank the questions again
              <span className="font-normal text-text2">Free: re-orders the questions not asked yet</span>
            </Button>
          )}
          {live && mayRepin && (
            <Button variant="ghost" role="menuitem" className="justify-start" disabled={busy} onClick={() => (close(), act(() => unwrap(api.POST("/v1/intakes/{intake_id}/repin", { params: { path: { intake_id: id } } }))))}>
              Pin new sources
              {fresh > 0 && (
                <span className="font-normal text-text2">
                  {plural(fresh, "new item")} since {s.new_evidence.as_of ? dayMonth(s.new_evidence.as_of) : "the pin"}
                </span>
              )}
            </Button>
          )}
          {live && mayArchive && !archived && (
            <Button
              variant="ghost"
              role="menuitem"
              className="justify-start"
              disabled={busy}
              onClick={() => (close(), archive())}
            >
              Archive
            </Button>
          )}
          {mayDelete && (
            <Button variant="ghost" role="menuitem" className="justify-start" disabled={busy} onClick={() => (close(), setDeleting(true))}>
              Delete…
            </Button>
          )}
        </div>
      )}
    </Menu>
  );

  return (
    <Page>
      <PageHeader
        back={<BackToPrds />}
        title={s.intake.title}
        status={
          <>
            {converted && s.draft_run_id ? (
              <Link href={`/runs/${s.draft_run_id}`} data-testid="intake-status-link">
                <Chip kind={status.kind} dot data-testid="intake-status">
                  {status.label}
                </Chip>
              </Link>
            ) : (
              <Chip kind={status.kind} dot data-testid="intake-status">
                {status.label}
              </Chip>
            )}
          </>
        }
        action={
          <>
            {mayDraft && !converted && !archived && (
              <Button variant="primary" icon="doc" disabled={busy || blocked} title={reason ?? undefined} onClick={() => setDrafting(true)}>
                Draft with Oracle
              </Button>
            )}
            {more}
          </>
        }
      />
      {reason && !converted && (
        <p data-testid="draft-reason" className="-mt-1 mb-3 text-sm font-medium text-crit">
          {reason}
        </p>
      )}
      {s.ai_read && (
        <ReadLine
          read={s.ai_read}
          openGaps={openGaps}
          asked={(batchesQ.data ?? []).reduce((n, b) => n + b.questions.length, 0)}
          mayRead={mayRead && !converted && !archived}
          busy={busy}
          onPoll={changed}
          onRead={() => act(() => unwrap(api.POST("/v1/intakes/{intake_id}/ai-read", { params: { path: { intake_id: id } } })))}
        />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {archived && (
        <Notice testId="intake-archived">This brief is archived: it has left PRDs › Ideas and Oracle asks nothing more.</Notice>
      )}
      {phone && <PhoneReadiness summary={s} batches={batchesQ.data ?? undefined} onOpen={() => setSheet(true)} />}
      <Split inspector={phone ? undefined : inspector}>
        <TabBar<Tab>
          label="Before drafting"
          tabs={[
            { id: "questions", label: "Questions" },
            { id: "gaps", label: "Gaps", count: openGaps },
            { id: "proposals", label: "Proposals", count: s.proposals.filter((p) => p.status === "proposed").length },
            { id: "findings", label: "Findings" },
          ]}
          value={tab}
          onChange={setTab}
          idFor={(t) => `intake-${t}`}
        />
        <div role="tabpanel" id={`intake-${tab}-panel`} aria-labelledby={`intake-${tab}`} className="min-w-0">
          {tab === "questions" && (
            <>
              {batchesQ.error && <ErrorNote>{batchesQ.error}</ErrorNote>}
              {batchesQ.data ? (
                <QuestionsTab summary={s} batches={batchesQ.data} me={{ id: me?.user_id ?? null, role }} version={version} onChanged={changed} />
              ) : (
                <Loading />
              )}
            </>
          )}
          {tab === "gaps" && <GapsTab summary={s} onChanged={changed} />}
          {tab === "proposals" && <ProposalsTab summary={s} onChanged={changed} />}
          {tab === "findings" && <FindingsTab intakeId={id} author={author} version={version} />}
        </div>
      </Split>
      {/* C4: Draft with Oracle opens its sheet (template, baseline, depth, stops, estimate). Closed,
          the summary is read again: the brief's draft run, if the sheet made one, is taken up next time. */}
      {deleting &&
        createPortal(
          <DeleteDialog
            title={s.intake.title}
            dependents={() => unwrap(api.GET("/v1/intakes/{intake_id}/dependents", { params: { path: { intake_id: id } } }))}
            remove={(query) => unwrap(api.DELETE("/v1/intakes/{intake_id}", { params: { path: { intake_id: id }, query } }))}
            onClose={() => setDeleting(false)}
            onDeleted={() => router.push("/documents")}
          />,
          document.body,
        )}
      {drafting && <DraftSheet summary={s} onClose={() => (setDrafting(false), changed())} />}
      {phone && (
        <Sheet open={sheet} title="Before drafting" onClose={() => setSheet(false)} testId="intake-sheet">
          <div className="p-2">{inspector}</div>
        </Sheet>
      )}
    </Page>
  );
}

/** The header's way back; rirs-25: at least 24 px tall, so a thumb hits it on a phone. */
function BackToPrds() {
  return (
    <Link href="/documents" data-testid="intake-back" className="inline-flex min-h-6 items-center gap-1 py-0.5 hover:text-text hover:underline">
      <Icon name="back" size={16} />
      PRDs
    </Link>
  );
}

/**
 * qa-work-22: on a phone the inspector is a sheet, so a short summary stays on the page (where
 * the brief stands, the counts) with the sheet behind "Show details". qa-work-29: in the
 * inspector's own words (Before drafting, its title, its counts); the Gaps tab below is the
 * one way to the gaps.
 */
function PhoneReadiness({ summary: s, batches, onOpen }: { summary: Summary; batches: Batch[] | undefined; onOpen: () => void }) {
  const state = readiness(s);
  const counts = tally(s, batches);
  const note = unknownNote(counts);
  return (
    <section aria-label="Before drafting" data-testid="intake-readiness" className="mb-3 flex flex-col gap-2 rounded-panel border border-line bg-surface p-3 shadow-panel">
      <p className="text-[12px] font-semibold tracking-wide text-text2 uppercase">Before drafting</p>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-text">{readinessTitle(s)}</h2>
        <Chip kind={state.kind} dot>
          {state.label}
        </Chip>
      </div>
      <p className="text-sm text-text2" data-testid="intake-readiness-counts">
        {counts.open} open · {counts.answered} answered · {s.readiness.open_critical} critical open
      </p>
      {note && <p className="text-[13px] text-text2">{note}</p>}
      <Button className="w-full" onClick={onOpen}>
        Show details
      </Button>
    </section>
  );
}
