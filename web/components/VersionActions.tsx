"use client";

import { useState } from "react";

import { InlineError, Menu } from "@/components/review/parts";
import { Button, Chip } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

// O1f: Full (as before), Brief and Deck. Full keeps its labels ("Export PDF").
const GROUPS = [
  {
    layer: "full",
    label: "Full",
    formats: [
      { format: "html", label: "HTML" },
      { format: "pdf", label: "PDF" },
      { format: "md", label: "MD" },
    ],
  },
  {
    layer: "brief",
    label: "Brief",
    formats: [
      { format: "pdf", label: "PDF" },
      { format: "html", label: "HTML" },
    ],
  },
  {
    layer: "deck",
    label: "Deck",
    formats: [
      { format: "pdf", label: "PDF" },
      { format: "pptx", label: "PPTX" },
    ],
  },
] as const;

type Layer = (typeof GROUPS)[number]["layer"];
type Format = "html" | "pdf" | "md" | "pptx";

/** Downloads an export (with version banner) through the typed client. */
export function ExportButtons({ doc, n, hasBrief = false }: { doc: string; n: number; hasBrief?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(layer: Layer, format: Format) {
    setBusy(`${layer}.${format}`);
    setError(null);
    try {
      const blob = await unwrap<Blob>(
        api.GET("/v1/documents/{doc}/versions/{n}/export", {
          params: { path: { doc, n }, query: { format, layer } },
          parseAs: "blob",
        }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc}-v${n}${layer === "full" ? "" : `-${layer}`}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  const groups = GROUPS.filter((g) => hasBrief || g.layer === "full");
  return (
    <Menu label="Export">
      <div className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <div
            key={g.layer}
            role="group"
            aria-label={`Export ${g.label.toLowerCase()}`}
            className="flex items-center justify-between gap-4"
          >
            <span className="text-[13px] font-semibold tracking-[0.02em] text-text2">{g.label}</span>
            <span className="flex gap-1.5">
              {g.formats.map((f) => (
                <Button
                  key={f.format}
                  disabled={busy !== null}
                  onClick={() => download(g.layer, f.format)}
                  aria-label={g.layer === "full" ? `Export ${f.label}` : `Export ${g.layer} ${f.label}`}
                  className="min-w-14"
                >
                  {busy === `${g.layer}.${f.format}` ? "…" : f.label}
                </Button>
              ))}
            </span>
          </div>
        ))}
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Menu>
  );
}

/** Approve the version (document → approved), with an inline confirmation step. */
export function ApproveButton({
  doc,
  n,
  approvedAt,
  isLatest,
  onApproved,
}: {
  doc: string;
  n: number;
  approvedAt?: string | null;
  isLatest: boolean;
  onApproved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (approvedAt) {
    return (
      <Chip kind="pass" title={`Approved ${formatDate(approvedAt)}`} className="h-10 px-4 text-[15px]">
        ✓ Approved {formatDate(approvedAt)}
      </Chip>
    );
  }

  async function approve() {
    setSaving(true);
    setError(null);
    try {
      await unwrap(api.POST("/v1/documents/{doc}/versions/{n}/approve", { params: { path: { doc, n } } }));
      setConfirming(false);
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve.");
    } finally {
      setSaving(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="primary" icon="check" onClick={() => setConfirming(true)}>
        Approve version
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Confirm approval">
      <span className="text-sm font-semibold text-text2">{isLatest ? `Approve v${n}?` : `v${n} is not the latest. Approve?`}</span>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      <Button variant="primary" icon="check" disabled={saving} onClick={approve} autoFocus>
        {saving ? "Approving…" : "Confirm"}
      </Button>
      {error && (
        <span role="alert" className="basis-full text-right text-sm font-medium text-crit">
          {error}
        </span>
      )}
    </div>
  );
}
