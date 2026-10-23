"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Button, InfoTip, Sheet } from "@/components/ds";
import { ErrorNote, INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { todayIn, useCompanyZone } from "@/lib/dates";
import { errorMessage } from "@/lib/use-query";

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
 * can instead start from the empty template.
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
  const [span, setSpan] = useState(() => defaultSpan(todayIn(zone)));
  const [fromApproved, setFromApproved] = useState(approvedVersion != null);
  const [busy, setBusy] = useState<"oracle" | "empty" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(doc?.slug ?? null);
  const title = doc ? "Draft next version" : kind === "vision" ? "New vision" : "New product strategy";
  const vision = kind === "vision";
  const yearsN = Number(years);
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

  return (
    <Sheet open title={title} onClose={onClose} testId="strategy-draft-sheet">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4 max-[600px]:px-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void draftWithOracle();
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-[15px] font-semibold text-text">What changed since the last one</span>
          <textarea
            data-autofocus
            rows={3}
            maxLength={4000}
            className={INPUT}
            value={changed}
            onChange={(e) => setChanged(e.target.value)}
            placeholder="Optional: a market shift, a goal that moved, a bet that did not pay off."
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
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!valid || busy !== null}>
            {busy === "oracle" ? "Starting…" : "Draft with Oracle"}
          </Button>
          <InfoTip label="drafting with Oracle" align="start">
            Oracle reads the confirmed goals, approved PRDs and roadmaps, decisions, outcomes and the company&apos;s own strategy material, and
            writes the draft. An owner reviews and approves it.
          </InfoTip>
          {!doc && (
            <Button variant="ghost" className="ml-auto" disabled={busy !== null} onClick={emptyTemplate}>
              {busy === "empty" ? "Creating…" : "Start from the empty template"}
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
