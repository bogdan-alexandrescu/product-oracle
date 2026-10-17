"use client";

import { useState } from "react";

import { Badge, Button } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";

const FORMATS = [
  { format: "html", label: "HTML" },
  { format: "pdf", label: "PDF" },
  { format: "md", label: "MD" },
] as const;

/** Downloads an export (with version banner) through the typed client. */
export function ExportButtons({ doc, n }: { doc: string; n: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: (typeof FORMATS)[number]["format"]) {
    setBusy(format);
    setError(null);
    try {
      const blob = await unwrap<Blob>(
        api.GET("/v1/documents/{doc}/versions/{n}/export", {
          params: { path: { doc, n }, query: { format } },
          parseAs: "blob",
        }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc}-v${n}.${format}`;
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

  return (
    <div className="flex items-center gap-2">
      <div role="group" aria-label="Export" className="flex items-center">
        <span className="mr-2 text-sm text-neutral-600">Export</span>
        {FORMATS.map((f, i) => (
          <Button
            key={f.format}
            size="sm"
            className={`${i > 0 ? "-ml-px rounded-l-none" : ""} ${i < FORMATS.length - 1 ? "rounded-r-none" : ""}`}
            disabled={busy !== null}
            onClick={() => download(f.format)}
            aria-label={`Export ${f.label}`}
          >
            {busy === f.format ? "…" : f.label}
          </Button>
        ))}
      </div>
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
