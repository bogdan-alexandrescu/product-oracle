"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { toast } from "@/components/ds/Toast";
import { PrdMoveMenu } from "@/components/simple/PrdMoveMenu";
import { NewPrdButton, NewPrdSheet, StartedRows, useCanStartPrd, useStartedPrds } from "@/components/simple/NewPrd";
import { PrdStatus } from "@/components/simple/PrdStatus";
import { dmy } from "@/components/simple/PrdTimeline";
import { SimpleEmpty, SimplePage, SimpleSection } from "@/components/simple/SimplePage";
import { Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone, dayIn } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { sortPrds } from "@/lib/prd-order";
import { useQuery } from "@/lib/use-query";

/** One-pagers (#723 S1): the PRDs I may read (the API lists only those), each opening its one-pager. */
export default function OnePagers() {
  const q = useQuery("simple|one-pagers", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const zone = useCompanyZone();
  const canStartPrd = useCanStartPrd();
  const [newPrd, setNewPrd] = useState(false);
  const closeNewPrd = useCallback(() => setNewPrd(false), []);
  const started = useStartedPrds(canStartPrd);
  const mine = started.data ?? [];
  // prd-order: the one company PRD order; owners move a PRD up or down from its ⋯.
  const rows = q.data ? sortPrds(q.data) : null;
  const { can } = useMe();
  const canMove = can("move_document");
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // A move says what it did, with an Undo that puts every PRD's stored place back as it was.
  const move = useCallback(
    async (d: { slug: string; title: string }, to: "up" | "down") => {
      const before = (q.data ?? []).map((x) => ({ document_id: x.id, position: x.position ?? null }));
      setMoving(true);
      setMoveError(null);
      try {
        await unwrap(api.POST("/v1/documents/{doc}/move", { params: { path: { doc: d.slug } }, body: { to } }));
        await q.reload();
        toast({
          message: `Moved ${d.title} ${to}.`,
          action: {
            label: "Undo",
            onClick: () =>
              void unwrap(api.PUT("/v1/documents/prd-order", { body: { positions: before } }))
                .then(() => q.reload())
                .catch(() => setMoveError("Oracle could not undo the move. Try again.")),
          },
        });
      } catch {
        setMoveError("Oracle could not move the PRD. Try again.");
      } finally {
        setMoving(false);
      }
    },
    [q],
  );
  return (
    // qa4-simple-prd-25: a help line, saying what a person can do here.
    <SimplePage title="One-pagers" lead="Open a PRD to read it on one page, change its wording or start a review.">
      <SimpleSection
        title="PRDs"
        testId="simple-one-pagers"
        action={
          // NP1: New PRD beside "Company order", opening the guided sheet.
          <span className="flex flex-wrap items-center gap-3">
            {/* prd-order: the list says its order, the one company PRD order. */}
            {rows && rows.length + mine.length > 1 ? (
              <span className="simple-small" data-testid="one-pagers-order">
                Company order
              </span>
            ) : null}
            {canStartPrd && <NewPrdButton primary onOpen={() => setNewPrd(true)} />}
          </span>
        }
      >
        {q.error ? (
          <p className="simple-small">{q.error}</p>
        ) : !rows ? (
          <Loading />
        ) : rows.length === 0 && mine.length === 0 ? (
          // qa-simple-prd-41: what a one-pager comes from, and where to start one.
          <SimpleEmpty testId="simple-one-pagers-empty">
            No PRDs yet. A one-pager is made from a PRD: start one in{" "}
            <Link href="/documents" className="font-semibold text-accent-ink underline">Detailed › PRDs</Link>, and its one-pager shows here.
          </SimpleEmpty>
        ) : (
          // qa-simple-prd-42: the status sits beside its title, rows are ruled, each says when it changed.
          // qa-simple-prd-p3-29: the whole row opens the one-pager, as its hover says: the title's
          // link stretches over the row (one link still, its name the title).
          <ul className="flex flex-col">
            {moveError && (
              <li role="alert" className="simple-small py-2 text-warn">
                {moveError}
              </li>
            )}
            <StartedRows started={mine} />
            {rows.map((d, n) => (
              <li key={d.id} data-testid="one-pager-row" className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0 hover:bg-bg/50">
                <Link href={`/simple/one-pagers/${d.slug}`} className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:content-[''] hover:underline">
                  {d.title}
                </Link>
                <PrdStatus d={d} />
                <span className="simple-small ml-auto">Updated {dmy(dayIn(d.updated_at, zone))}</span>
                {canMove && rows.length > 1 && (
                  <PrdMoveMenu title={d.title} busy={moving} onUp={n > 0 ? () => void move(d, "up") : undefined} onDown={n < rows.length - 1 ? () => void move(d, "down") : undefined} />
                )}
              </li>
            ))}
          </ul>
        )}
      </SimpleSection>
      {newPrd && <NewPrdSheet onClose={closeNewPrd} onStarted={() => void started.reload()} />}
    </SimplePage>
  );
}
