"use client";

import Link from "next/link";
import { useState } from "react";

import { InlineError, Menu } from "@/components/review/parts";
import { Button, Chip } from "@/components/ds";
import { DownloadNote, useDownloadNote } from "@/components/DownloadNote";
import { api, unwrap } from "@/lib/api/client";
import { downloadedNote } from "@/lib/export-note";
import { formatDate } from "@/lib/format";

// O1f: Full (as before), Brief and Deck. Full keeps its labels ("Export PDF").
// qa-docs-53: one order on every row: PDF, then HTML, then the row's own (MD, PPTX).
const GROUPS = [
  {
    layer: "full",
    label: "Full",
    formats: [
      { format: "pdf", label: "PDF" },
      { format: "html", label: "HTML" },
      // qa4-docs-31: the format by its name, not a bare "MD".
      { format: "md", label: "Markdown (.md)" },
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
  // e2e-pdf-export: a download closes the menu and says so a few seconds, as the one-pager's.
  const [saved, setSaved] = useDownloadNote();

  async function download(layer: Layer, format: Format, label: string, close: () => void) {
    setBusy(`${layer}.${format}`);
    setError(null);
    try {
      const call = api.GET("/v1/documents/{doc}/versions/{n}/export", {
        params: { path: { doc, n }, query: { format, layer } },
        parseAs: "blob",
      });
      const blob = await unwrap<Blob>(call);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc}-v${n}${layer === "full" ? "" : `-${layer}`}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      close();
      setSaved(downloadedNote(label, (await call).response, "shorten it, or pick a theme without a page limit"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  }

  const groups = GROUPS.filter((g) => hasBrief || g.layer === "full");
  // qa-docs-75: a grid, so a format sits in the same column on every row: PDF, HTML, then the
  // row's own (MD, PPTX). The panel opens clear of the review panel's totals.
  const COLUMN: Record<Format, string> = { pdf: "col-start-2", html: "col-start-3", md: "col-start-4", pptx: "col-start-4" };
  return (
    <>
      <Menu label="Export" avoid='[data-testid="review-panel"]'>
        {(close) => (
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-[auto_repeat(3,minmax(3.5rem,auto))] items-center gap-x-1.5 gap-y-2.5">
              {groups.map((g) => (
                <div key={g.layer} role="group" aria-label={`Export ${g.label.toLowerCase()}`} className="contents">
                  <span className="col-start-1 pr-2.5 text-[13px] font-semibold tracking-[0.02em] text-text2">{g.label}</span>
                  {g.formats.map((f) => (
                    <Button
                      key={f.format}
                      disabled={busy !== null}
                      onClick={() => download(g.layer, f.format, f.label, close)}
                      aria-label={g.layer === "full" ? `Export ${f.label}` : `Export ${g.layer} ${f.label}`}
                      className={`${COLUMN[f.format]} min-w-14`}
                    >
                      {busy === `${g.layer}.${f.format}` ? "…" : f.label}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
            {error && <InlineError>{error}</InlineError>}
          </div>
        )}
      </Menu>
      <DownloadNote note={saved} />
    </>
  );
}

/** Approve the version (document → approved), with an inline confirmation step. */
export function ApproveButton({
  doc,
  n,
  approvedAt,
  isLatest,
  onApproved,
  blockedReason,
  blockedFix,
  unreviewed,
}: {
  doc: string;
  n: number;
  approvedAt?: string | null;
  isLatest: boolean;
  onApproved: () => void;
  /** Why the version cannot be approved now (a roadmap's marked dates, O4): Approve is disabled. */
  blockedReason?: string;
  /** qa-docs-6: where what blocks it is fixed, a link after the reason. */
  blockedFix?: { href: string; label: string };
  /** #254: sections not reviewed, of all; the confirm names them. */
  unreviewed?: { count: number; total: number };
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

  if (blockedReason) {
    // qa-docs-7: the button sits in the header's row of actions, beside Discuss; the reason
    // (and where to fix it) takes a line of its own below them, right-aligned (left on a phone).
    return (
      <div className="contents" data-testid="approve-blocked">
        <Button
          variant="primary"
          icon="check"
          disabled
          aria-describedby="approve-blocked-reason"
          title={blockedReason}
          className="max-[600px]:mr-auto"
        >
          Approve version
        </Button>
        <span className="flex basis-full justify-end max-[600px]:justify-start">
          <span
            id="approve-blocked-reason"
            className="w-[28rem] max-w-full text-right text-sm font-medium break-words text-warn max-[600px]:w-full max-[600px]:text-left"
          >
            {blockedReason}
            {blockedFix && (
              <>
                {" "}
                <Link href={blockedFix.href} data-testid="approve-blocked-fix" className="font-semibold underline underline-offset-2">
                  {blockedFix.label}
                </Link>
              </>
            )}
          </span>
        </span>
      </div>
    );
  }

  if (!confirming) {
    // qa-docs-66: an earlier version does not push its approval: a quiet button, saying which.
    return (
      <Button
        variant={isLatest ? "primary" : "secondary"}
        icon="check"
        data-testid="approve-version"
        aria-description={isLatest ? undefined : `v${n} is an earlier version`}
        onClick={() => setConfirming(true)}
      >
        Approve version
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Confirm approval">
      {unreviewed && unreviewed.count > 0 && (
        <span data-testid="unreviewed-sections" className="text-sm font-semibold text-warn">
          {unreviewed.count} of {unreviewed.total} sections {unreviewed.count === 1 ? "is" : "are"} not reviewed.
        </span>
      )}
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
