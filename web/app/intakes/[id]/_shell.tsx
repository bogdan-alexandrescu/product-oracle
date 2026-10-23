"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";

import { Button, Chip, confirmInPage, Notice, Page, PageHeader, Sheet, Split } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { Menu, TabBar } from "@/components/review/parts";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { DraftSheet } from "./_draft-sheet";
import { IntakeInspector } from "./_inspector";
import { OPEN_GAP, STATUS, dayMonth, gateReason, type Batch } from "./_lib";
import { QuestionsTab } from "./_questions";

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

type Tab = "questions";

/**
 * Before drafting (C5, B1 Split): what Oracle still needs to know about a brief, asked of
 * named people in short batches, and whether the PRD is ready to draft. Draft with Oracle
 * waits while a critical question is open (C5 "Draft gate", decided 2026-10-21): answer it,
 * or record a decision from the inspector.
 */
export function BeforeDrafting({ id }: { id: string }) {
  const { me, role, can } = useMe();
  const phone = useIsPhone();
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("questions");
  const [sheet, setSheet] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryQ = useQuery(
    `intake|${id}|${version}`,
    () => unwrap(api.GET("/v1/intakes/{intake_id}/summary", { params: { path: { intake_id: id } } })),
    { keepPrevious: true },
  );
  const s = summaryQ.data;
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
    });
  }

  if (!s) {
    return <Page>{summaryQ.error ? <ErrorNote>{summaryQ.error}</ErrorNote> : <Loading />}</Page>;
  }

  const gate = s.readiness;
  const blocked = gate.gate === "blocked";
  const author = s.intake.author_id === me?.user_id;
  // #370: what the controls call. Drafting is an approver's (start_intake_run); archiving
  // is the author's or an approver's (the handler's author_or); Re-analyse and Pin new
  // sources are the author's only.
  const mayDraft = can("start_intake_run");
  const mayArchive = can("update_intake", author || mayDraft);
  const mayAnalyze = author && can("analyze_intake");
  const mayRepin = author && can("repin_intake");
  const converted = s.intake.status === "converted";
  const archived = s.intake.status === "archived";
  const reason = blocked ? gateReason(gate.blocking_gap_ids.length) : null;
  const status = STATUS[s.intake.status];
  const openGaps = s.gaps.filter((g) => OPEN_GAP.has(g.status)).length;
  const fresh = s.new_evidence.visible ? (s.new_evidence.count ?? 0) : 0;

  const inspector = <IntakeInspector summary={s} role={role} onChanged={changed} />;
  const more = (mayAnalyze || mayRepin || (mayArchive && !archived)) && !converted && (
    <Menu label="More actions" icon="more" iconOnly>
      {(close) => (
        <div className="flex min-w-48 flex-col gap-1" role="menu">
          {mayAnalyze && (
            <Button variant="ghost" role="menuitem" className="justify-start" disabled={busy} onClick={() => (close(), act(() => unwrap(api.POST("/v1/intakes/{intake_id}/analyze", { params: { path: { intake_id: id } } }))))}>
              Re-analyse
            </Button>
          )}
          {mayRepin && (
            <Button variant="ghost" role="menuitem" className="justify-start" disabled={busy} onClick={() => (close(), act(() => unwrap(api.POST("/v1/intakes/{intake_id}/repin", { params: { path: { intake_id: id } } }))))}>
              Pin new sources
              {fresh > 0 && (
                <span className="font-normal text-text2">
                  {fresh} new item{fresh === 1 ? "" : "s"} since {s.new_evidence.as_of ? dayMonth(s.new_evidence.as_of) : "the pin"}
                </span>
              )}
            </Button>
          )}
          {mayArchive && !archived && (
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
        </div>
      )}
    </Menu>
  );

  return (
    <Page>
      <PageHeader
        back={
          <Link href="/documents" className="hover:text-text hover:underline">
            ‹ PRDs
          </Link>
        }
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
      {error && <Notice tone="error">{error}</Notice>}
      {archived && (
        <Notice testId="intake-archived">This brief is archived: it has left PRDs › Ideas and Oracle asks nothing more.</Notice>
      )}
      {phone && (
        <Button className="mb-3 w-full" onClick={() => setSheet(true)}>
          Gaps {openGaps} open
        </Button>
      )}
      <Split inspector={phone ? undefined : inspector}>
        <TabBar<Tab> label="Before drafting" tabs={[{ id: "questions", label: "Questions" }]} value={tab} onChange={setTab} idFor={(t) => `intake-${t}`} />
        <div role="tabpanel" id="intake-questions-panel" aria-labelledby="intake-questions" className="min-w-0">
          {batchesQ.error && <ErrorNote>{batchesQ.error}</ErrorNote>}
          {batchesQ.data ? (
            <QuestionsTab summary={s} batches={batchesQ.data} me={{ id: me?.user_id ?? null, role }} version={version} onChanged={changed} />
          ) : (
            <Loading />
          )}
        </div>
      </Split>
      {/* C4: Draft with Oracle opens its sheet (template, baseline, depth, stops, estimate). Closed,
          the summary is read again: the brief's draft run, if the sheet made one, is taken up next time. */}
      {drafting && <DraftSheet summary={s} onClose={() => (setDrafting(false), changed())} />}
      {phone && (
        <Sheet open={sheet} title="Before drafting" onClose={() => setSheet(false)} testId="intake-sheet">
          <div className="p-2">{inspector}</div>
        </Sheet>
      )}
    </Page>
  );
}
