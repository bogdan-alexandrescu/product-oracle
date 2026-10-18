"use client";

import { useState } from "react";

import { Badge, Button } from "@/components/ui";
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
    <div className="flex items-center gap-2">
      <span className="text-sm text-neutral-600">Export</span>
      {groups.map((g) => (
        <div key={g.layer} role="group" aria-label={`Export ${g.label.toLowerCase()}`} className="flex items-center">
          {hasBrief && <span className="mr-1 text-xs text-neutral-500">{g.label}</span>}
          {g.formats.map((f, i) => (
            <Button
              key={f.format}
              size="sm"
              className={`${i > 0 ? "-ml-px rounded-l-none" : ""} ${i < g.formats.length - 1 ? "rounded-r-none" : ""}`}
              disabled={busy !== null}
              onClick={() => download(g.layer, f.format)}
              aria-label={g.layer === "full" ? `Export ${f.label}` : `Export ${g.layer} ${f.label}`}
            >
              {busy === `${g.layer}.${f.format}` ? "…" : f.label}
            </Button>
          ))}
        </div>
      ))}
      {error && (
        <span role="alert" className="text-xs text-rose-700">
          {error}
        </span>
      )}
    </div>
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
      <Badge tone="green" title={`Approved ${formatDate(approvedAt)}`}>
        ✓ Approved {formatDate(approvedAt)}
      </Badge>
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
      <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
        Approve version
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Confirm approval">
      <span className="text-xs text-neutral-600">
        {isLatest ? `Approve v${n}?` : `v${n} is not the latest. Approve anyway?`}
      </span>
      <Button variant="primary" size="sm" disabled={saving} onClick={approve} autoFocus>
        {saving ? "Approving…" : "Confirm"}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
      {error && <span className="text-xs text-rose-700">{error}</span>}
    </div>
  );
}
