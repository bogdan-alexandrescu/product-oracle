"use client";

import { useState } from "react";

import { Button, Dialog, Notice } from "@/components/ds";
import { Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

/**
 * one-roadmap-many-prds: on a PRD's page (approvers and owners), pick the PRDs that replace it
 * (one per area of focus), or clear it. A replaced PRD is read-only and its items stop feeding
 * the roadmap.
 */
export function ReplacedByButton({ prd, onSaved }: { prd: Schemas["DocumentOut"]; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Replaced by</Button>
      {open && (
        <ReplacedByDialog
          prd={prd}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            await onSaved();
          }}
        />
      )}
    </>
  );
}

function ReplacedByDialog({ prd, onClose, onSaved }: { prd: Schemas["DocumentOut"]; onClose: () => void; onSaved: () => Promise<void> }) {
  const listQ = useQuery("replaced-by|prds", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const before = (prd.replaced_by ?? []).map((r) => r.slug);
  const [picked, setPicked] = useState<string[]>(before);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = (listQ.data ?? []).filter((d) => d.kind === "prd" && d.id !== prd.id);
  const dirty = picked.join() !== before.join();

  async function save(prds: string[]) {
    setBusy(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/replaced-by", { params: { path: { doc: prd.slug } }, body: { prds } }));
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const toggle = (slug: string) => {
    setError(null);
    setPicked((now) => (now.includes(slug) ? now.filter((s) => s !== slug) : [...now, slug]));
  };

  return (
    <Dialog
      title="Replaced by"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      testId="replaced-by-dialog"
      head={<p className="mt-1.5 text-sm text-text2">Pick the PRDs that replace {prd.title}. It turns read-only and its items stop feeding the roadmap.</p>}
      actions={
        <>
          {before.length > 0 && (
            <Button disabled={busy} onClick={() => void save([])}>
              Clear
            </Button>
          )}
          <Button variant="primary" disabled={busy || !dirty || picked.length === 0} onClick={() => void save(picked)}>
            Save
          </Button>
        </>
      }
    >
      {listQ.error && <Notice tone="error">{listQ.error}</Notice>}
      {!listQ.data && !listQ.error && <Loading />}
      {listQ.data && others.length === 0 && <p className="text-[15px] text-text2">No other PRDs yet.</p>}
      {others.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">PRDs</legend>
          {others.map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-[15px]">
              <input type="checkbox" checked={picked.includes(d.slug)} onChange={() => toggle(d.slug)} />
              {d.title}
            </label>
          ))}
        </fieldset>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
