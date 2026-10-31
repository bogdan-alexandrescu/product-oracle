"use client";

import { useState } from "react";

import { Chip, Empty, SegmentedControl, type Segment } from "@/components/ds";
import { InlineError } from "@/components/review/parts";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CATEGORY_LABEL, type Category } from "./_lib";

type Finding = Schemas["FindingOut"];
type Sharing = Finding["sharing"];

const KIND: Record<Finding["kind"], string> = { item: "Item", gap: "Gap", conflict: "Conflict", stale: "Stale source" };
const LEVELS: { value: Sharing; label: string; title: string }[] = [
  { value: "private", label: "Private", title: "Only you see it" },
  { value: "counts", label: "Counts", title: "Others see that it exists, as a count" },
  { value: "summary", label: "Summary", title: "Others see a one-line summary" },
  { value: "full", label: "Full", title: "Others see the finding and the sources it cites" },
];
const AUTHOR_REASON = "Only the brief's author sets what others see of findings from their own sources.";

function FindingRow({ f, author, intakeId, onSet }: { f: Finding; author: boolean; intakeId: string; onSet: (f: Finding) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const category = f.category ? (CATEGORY_LABEL[f.category as Category] ?? f.category) : null;
  const line = f.draft_summary ?? f.summary;

  async function set(sharing: Sharing) {
    setBusy(true);
    setError(null);
    try {
      onSet(
        await unwrap(
          api.PATCH("/v1/intakes/{intake_id}/findings/{finding_id}", { params: { path: { intake_id: intakeId, finding_id: f.id } }, body: { sharing } }),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const items: Segment<Sharing>[] = LEVELS.map((l) => ({ ...l, disabled: busy || (!author && l.value !== f.sharing), title: author ? l.title : AUTHOR_REASON }));
  return (
    <li data-testid="finding" className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-3 text-text">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip kind="acc">{KIND[f.kind]}</Chip>
        {category && <span className="text-[13px] text-text2">{category}</span>}
      </div>
      <p className="text-[15px] break-words">{line ?? <span className="text-text2">Shared as a count only</span>}</p>
      <SegmentedControl<Sharing> label="Who sees this finding" size="sm" items={items} value={f.sharing} onChange={author ? set : undefined} />
      {error && <InlineError>{error}</InlineError>}
    </li>
  );
}

/**
 * Findings from the brief author's own sources (S6, #343) and what others see of each:
 * private, counts, summary or full. The author sets the level; everyone else reads the
 * findings shared with them, the control disabled.
 */
export function FindingsTab({ intakeId, author, version }: { intakeId: string; author: boolean; version: number }) {
  const q = useQuery(
    `intake-findings|${intakeId}|${version}`,
    () => unwrap(api.GET("/v1/intakes/{intake_id}/findings", { params: { path: { intake_id: intakeId } } })),
    { keepPrevious: true },
  );
  const set = (f: Finding) => q.setData((prev) => prev?.map((x) => (x.id === f.id ? f : x)));
  return (
    <div data-testid="intake-findings" className="flex min-w-0 flex-col gap-3 pt-3">
      {!author && (
        <p data-testid="findings-role-note" role="note" className="text-[13px] text-text2">
          {AUTHOR_REASON}
        </p>
      )}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {!q.data ? (
        !q.error && <Loading />
      ) : q.data.length === 0 ? (
        // qa4-work-9: what the tab is for and what to do next, not only that it is empty.
        <Empty testId="findings-empty">
          {author ? (
            <>
              Oracle has found nothing in your own sources yet.
              <br />
              When Oracle reads the brief with sources only you can see, what it finds shows here and you choose who else sees it. To add some, use Pin new sources in the brief&apos;s Actions menu, then read the brief again.
            </>
          ) : (
            // The role note above says who shares them.
            "No findings shared with you yet."
          )}
        </Empty>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {q.data.map((f) => (
            <FindingRow key={f.id} f={f} author={author} intakeId={intakeId} onSet={set} />
          ))}
        </ul>
      )}
    </div>
  );
}
