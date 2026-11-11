"use client";

import { useState } from "react";

import { GroundTruthFlags } from "@/app/baseline/_components/GroundTruthFlags";
import { Dialog } from "@/components/ds/Dialog";
import { Icon } from "@/components/ds/Icon";
import { InfoTip } from "@/components/ds/InfoTip";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

type Check = Schemas["GroundTruthOut"];

/** The sheet's title holds the band's heading and total: the band drops its own, and its frame. */
const BARE = "[&_[data-testid=gt-band]]:m-0 [&_[data-testid=gt-band]]:border-0 [&_[data-testid=gt-band]]:p-0 [&_[data-testid=gt-band]>div:first-child]:hidden";

const flagsWord = (n: number) => (n === 1 ? "Ground Truth flag" : "Ground Truth flags");

/**
 * The Ground Truth page's own flags band in a sheet (full screen on a phone): the kinds, each flag
 * with its fix. The graph (for Link to a feature) and the open proposals are read once it opens.
 */
function Sheet({ check, onChanged, onClose }: { check: Check; onChanged: () => void; onClose: () => void }) {
  const { can } = useMe();
  const graph = useQuery("home-gt-graph", () => unwrap(api.GET("/v1/baseline/graph")));
  const proposals = useQuery("home-gt-proposals", () => unwrap(api.GET("/v1/baseline/proposals", { params: { query: { status: "open" } } })));
  return (
    <Dialog title={`Ground Truth flags · ${check.total}`} onClose={onClose} testId="gtf-sheet" phoneSheet scrollBody closeButton cancelLabel="Close">
      <div className={BARE}>
        {check.total === 0 && <p className="simple-small">No flags</p>}
        {/* Kept mounted with no flags left (the band hides at a total of 0), so the last fix's Undo stays. */}
        <GroundTruthFlags
          check={check.total === 0 ? { ...check, total: 1 } : check}
          graph={graph.data ?? undefined}
          proposals={proposals.data ?? undefined}
          canWrite={can("confirm_entity")}
          canPropose={can("create_proposal")}
          canChangeRoadmap={can("create_simple_change")}
          onChanged={() => {
            onChanged();
            void proposals.reload();
            void graph.reload();
          }}
        />
      </div>
    </Dialog>
  );
}

/**
 * The owner's pick (Nov 10, proposal A): one line at the foot of Home's Waiting for you card, the
 * count of Ground Truth flags (docs/ground-truth.md), opening a sheet of each flag and its fix. A
 * fix reads the check again, so the count changes at once; at 0 the line goes. `card`: a viewer's
 * Home has no Waiting card, so the line sits in a card of its own.
 */
export function GtWaitingLine({ card = false }: { card?: boolean }) {
  const [open, setOpen] = useState(false);
  const check = useQuery("home-gt-check", () => unwrap(api.GET("/v1/baseline/check")));
  const data = check.data;
  if (!data || (data.total === 0 && !open)) return null;
  const line = data.total > 0 && (
    <p data-testid="gtf-line" className={`simple-small flex flex-wrap items-center gap-x-1.5 gap-y-1 ${card ? "" : "mt-2 border-t border-line pt-2"}`}>
      <Icon name="flag" size={16} />
      <button type="button" className="simple-link" data-testid="gtf-open" onClick={() => setOpen(true)}>
        <span className="tnum">{data.total}</span> {flagsWord(data.total)}
      </button>
      <InfoTip label="Ground Truth flags" align="start">
        Anything that breaks the Ground Truth is allowed, and flagged here with its fix.
      </InfoTip>
    </p>
  );
  return (
    <>
      {/* At 0 the count goes and its open sheet stays, with the last fix's Undo. */}
      {line && card ? (
        <section aria-label="Waiting for you" data-testid="gtf-card" className="simple-card">
          {line}
        </section>
      ) : (
        line
      )}
      {open && <Sheet check={data} onChanged={() => void check.reload()} onClose={() => setOpen(false)} />}
    </>
  );
}
