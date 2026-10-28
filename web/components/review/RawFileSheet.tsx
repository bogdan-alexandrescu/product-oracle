"use client";

import { useEffect, useState } from "react";

import { Sheet } from "@/components/ds";
import { api } from "@/lib/api/client";

/**
 * A run file in a read-only sheet (D1 Raw file): as it is now, or the agents' text when
 * Approve with edits changed it (D7, `open === "agents"`). The review screen and the run
 * page's Roadmap items summary open it.
 */
export function RawFileSheet({
  open,
  onClose,
  runId,
  seq,
  name = "roadmap_items.yaml",
}: {
  open: "file" | "agents" | null;
  onClose: () => void;
  runId: string;
  seq: number;
  name?: string;
}) {
  const [loaded, setLoaded] = useState<{ which: string; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .GET("/v1/runs/{run_id}/segments/{seq}/artifacts/{name}", {
        params: { path: { run_id: runId, seq, name }, query: open === "agents" ? { agents: true } : {} },
        parseAs: "text",
      })
      .then(({ data, response }) => {
        if (live) setLoaded({ which: open, text: response.ok ? (data as string) : `Could not load ${name}. Try again.` });
      });
    return () => {
      live = false;
    };
  }, [open, runId, seq, name]);
  return (
    <Sheet open={!!open} title={open === "agents" ? "Agents' file" : "Raw file"} onClose={onClose} testId="sheet-raw-file">
      <pre className="mx-4 my-3 max-h-[70vh] overflow-auto rounded-button bg-surface2 p-3 font-mono text-[13px] whitespace-pre-wrap break-words" data-testid="raw-file-content">
        {loaded?.which === open ? loaded.text : "Loading…"}
      </pre>
    </Sheet>
  );
}
