"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Dialog, Notice } from "@/components/ds";
import { api, unwrap } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

/** Generate now (owners, can("create_alignment_report")): a report for the week so far, then open it. */
export function GenerateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [post, setPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const report = await unwrap(api.POST("/v1/alignment-reports", { body: { post_to_slack: post } }));
      router.push(`/plan/reports/${report.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Generate a report now"
      onClose={onClose}
      testId="generate-report-dialog"
      dirty={post}
      actions={
        <Button variant="primary" disabled={busy} onClick={generate} data-autofocus>
          Generate
        </Button>
      }
    >
      <p className="text-text2">The roadmap against engineering for the week so far, for every active or paused track.</p>
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} className="size-4 accent-[var(--accent)]" />
        Post to Slack
      </label>
      {error && <Notice tone="error">{error}</Notice>}
    </Dialog>
  );
}
