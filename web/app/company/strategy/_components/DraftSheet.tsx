"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, Dialog, InfoTip } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { AutonomyNote, useAutonomyLevel } from "@/lib/autonomy";
import { todayIn, useCompanyZone } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { errorMessage, useQuery } from "@/lib/use-query";

import { DOC, type DocKind, type DocRef } from "./lib";

/**
 * A strategy covers from the first of next month to the end of next year by default,
 * counted from `today` (YYYY-MM-DD) in the Company time zone (#401).
 */
function defaultSpan(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const from = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to: `${y + 1}-12-31` };
}

/**
 * New vision, New product strategy or Draft next version (H4 §3): what changed since the
 * last one, the horizon, and whether to start from the last approved version. Draft with
 * Oracle makes the document from the built-in template when there is none (start_draft),
 * then creates, estimates and starts the strategy_draft run and opens it. A new document
 * can instead start from the empty template. At Observe (H11: Settings › Autonomy's
 * "Shape product strategy" or "Draft the vision") Oracle drafts none: the sheet says so,
 * and a new document starts from the empty template only.
 */
export function DraftSheet({
  kind,
  doc,
  approvedVersion,
  onClose,
  onCreated,
}: {
  kind: DocKind;
  /** The vision or strategy document, when there is one: the run drafts its next version. */
  doc: DocRef | null;
  /** Its last approved version, when it has one. */
  approvedVersion: number | null;
  onClose: () => void;
  /** A new document was made (the page reloads its documents). */
  onCreated: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const [changed, setChanged] = useState("");
  const [years, setYears] = useState("5");
  const zone = useCompanyZone();
  const [initialSpan] = useState(() => defaultSpan(todayIn(zone)));
  const [span, setSpan] = useState(initialSpan);
  const [fromApproved, setFromApproved] = useState(approvedVersion != null);
  const [busy, setBusy] = useState<"oracle" | "empty" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(doc?.slug ?? null);
  const title = doc ? "Draft next version" : kind === "vision" ? "New vision" : "New product strategy";
  const vision = kind === "vision";
  const yearsN = Number(years);
  // H11: the responsibility keys are the document kinds ("strategy", "vision").
  const observing = useAutonomyLevel(kind) === "observe";
  // qa-company-14: typed work asks before it is thrown away (the ds Dialog's discard guard).
  const dirty = !!changed.trim() || years !== "5" || span.from !== initialSpan.from || span.to !== initialSpan.to;
  // qa-company-24: Draft with Oracle is a paid run: the button says what it costs, as New
  // update's does (the flow catalog's roles at standard depth, as the run's estimate counts them).
  const catalog = useQuery("flows", () => unwrap(api.GET("/v1/flows")));
  const cost = (() => {
    const c = catalog.data;
    const flow = c?.flows.find((f) => f.key === "strategy_draft");
    if (!c || !flow) return null;
    const base = flow.segments.reduce((sum, seg) => sum + seg.roles.reduce((n, r) => n + (c.roles.find((x) => x.key === r)?.base_usd ?? 0), 0), 0);
    return Math.round(base * (c.depths.standard ?? 1) * 100) / 100;
  })();
  const valid = vision ? Number.isInteger(yearsN) && yearsN >= 1 && yearsN <= 10 : !!span.from && !!span.to && span.to > span.from;

  /** The document's slug: the existing one, or a new one from the built-in template. */
  async function documentSlug(): Promise<string> {
    if (made) return made;
    const out = await unwrap(api.POST("/v1/drafts", { body: { kind, title: DOC[kind].title, template: DOC[kind].template } }));
    setMade(out.slug);
    onCreated();
    return out.slug;
  }

  async function draftWithOracle() {
    setBusy("oracle");
    setError(null);
    try {
      const slug = await documentSlug();
      const brief: Schemas["StrategyBriefIn"] = {
        changed: changed.trim() || null,
        from_approved: approvedVersion != null && fromApproved,
        ...(vision ? { horizon_years: yearsN } : { horizon_from: span.from, horizon_to: span.to }),
      };
      const run = await unwrap(
        api.POST("/v1/runs", {
          body: { flow: "strategy_draft", document: slug, knobs: { depth: "standard", roles: {}, checkpoints: {} }, strategy_brief: brief },
        }),
      );
      await unwrap(api.POST("/v1/runs/{run_id}/estimate", { params: { path: { run_id: run.id } } }));
      await unwrap(api.POST("/v1/runs/{run_id}/start", { params: { path: { run_id: run.id } } }));
      router.push(`/runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  async function emptyTemplate() {
    setBusy("empty");
    setError(null);
    try {
      router.push(`/documents/${await documentSlug()}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  // qa-company-14: the same centred dialog as every other create action (Propose decision,
  // Add metric, New update), not a full-width bottom sheet.
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="strategy-draft-sheet"
      // qa-company-24: one way to close, Cancel, as the other Company dialogs.
      closeButton={false}
      dirty={dirty}
      busy={busy !== null}
      onSubmit={() => {
        if (valid && !busy && !observing) void draftWithOracle();
      }}
      actions={
        <>
          {!doc && (
            // qa4-company-27: a bordered button, as it creates a document, not a text link beside Cancel.
            <Button variant={observing ? "primary" : "secondary"} disabled={busy !== null} onClick={emptyTemplate}>
              {busy === "empty" ? "Creating…" : "Start from the empty template"}
            </Button>
          )}
          {!observing && (
            <Button type="submit" variant="primary" disabled={!valid || busy !== null}>
              {busy === "oracle" ? "Starting…" : cost != null ? `Draft with Oracle · ${formatMoney(cost)}` : "Draft with Oracle"}
            </Button>
          )}
        </>
      }
    >
      <label className="block">
        {/* qa-company-12: a first vision or strategy has no last one to compare with. */}
        <span className="mb-1.5 block text-[15px] font-semibold text-text">
          {approvedVersion != null ? "What changed since the last one" : "Anything Oracle should know"}
        </span>
        <textarea
          data-autofocus
          rows={3}
          maxLength={4000}
          className={INPUT}
          value={changed}
          onChange={(e) => setChanged(e.target.value)}
          placeholder={
            approvedVersion != null
              ? "Optional: a market shift, a goal that moved, a bet that did not pay off."
              : "Optional: a market you are entering, a bet you have made, what you will not do."
          }
        />
      </label>
      {vision ? (
        <label className="block">
          <span className="mb-1.5 block text-[15px] font-semibold text-text">Horizon in years</span>
          <input type="number" min={1} max={10} className={`${INPUT} tnum w-28`} value={years} onChange={(e) => setYears(e.target.value)} />
        </label>
      ) : (
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-[15px] font-semibold text-text">Horizon</legend>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-text2">
              From
              <input type="date" className={`${INPUT} w-auto`} value={span.from} onChange={(e) => setSpan((s) => ({ ...s, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-2 text-sm font-semibold text-text2">
              To
              <input type="date" className={`${INPUT} w-auto`} value={span.to} onChange={(e) => setSpan((s) => ({ ...s, to: e.target.value }))} />
            </label>
          </div>
          {span.from && span.to && span.to <= span.from && <p className="mt-1.5 text-sm text-crit">The horizon ends before it starts.</p>}
        </fieldset>
      )}
      {approvedVersion != null && (
        <label className="flex items-center gap-2 text-[15px]">
          <input
            id={`${id}-from`}
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={fromApproved}
            onChange={(e) => setFromApproved(e.target.checked)}
          />
          Start from the last approved version (v{approvedVersion})
        </label>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {observing ? (
        <AutonomyNote testId="strategy-observing" onFollow={onClose}>
          Oracle is set to observe the {DOC[kind].name}, so it drafts none. {doc ? "Edit the document yourself" : "Start from the empty template"}, or
          change this in
        </AutonomyNote>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-text2">
          Oracle writes the draft; an owner reviews and approves it.
          <InfoTip label="drafting with Oracle" align="start">
            Oracle reads the confirmed goals, approved PRDs and roadmaps, decisions, outcomes and the company&apos;s own strategy material, and
            writes the draft. An owner reviews and approves it.
          </InfoTip>
        </p>
      )}
    </Dialog>
  );
}
