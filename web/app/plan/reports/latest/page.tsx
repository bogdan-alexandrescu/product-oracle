"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button, InfoTip, Page, PageHeader, Panel } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { useQuery } from "@/lib/use-query";

import { GenerateDialog } from "../_generate";

/**
 * The Plan header's Alignment report (F6 AC14): opens the newest report. The header links
 * here rather than to an id it loads itself, so a click before that load lands on the latest
 * report. With no report yet it says so (qa-plan-24) and, for a member who may, offers
 * Generate now, instead of landing on the empty list without a word.
 */
export default function LatestReportPage() {
  const router = useRouter();
  const { can, capsReady } = useMe();
  const [open, setOpen] = useState(false);
  const q = useQuery("alignment-reports|latest", () => unwrap(api.GET("/v1/alignment-reports", { params: { query: { limit: 1 } } })));
  const latest = q.data?.[0]?.id;
  const none = q.data != null && latest == null;
  useEffect(() => {
    if (latest) router.replace(`/plan/reports/${latest}`);
  }, [router, latest]);
  // capsReady too: `can` is false until the capabilities load, so an owner must not be
  // shown the viewer's wording (and no button) for that brief window.
  if (!none || !capsReady) return <div className="px-6 py-8">{q.error ? <ErrorNote>{q.error}</ErrorNote> : <Loading />}</div>;
  const canGenerate = can("create_alignment_report");
  return (
    <Page>
      {/* qa-plan-25: every Plan tab's page is titled "Plan", like the strip beneath it. */}
      <PageHeader
        title="Plan"
        info={
          <InfoTip label="Alignment reports" align="start" side="bottom">
            Each week Oracle reports how the tracks stand against their milestones and posts it to Slack. A report
            opens from here; the newest is also the Alignment report link.
          </InfoTip>
        }
      />
      <Panel testId="no-report-yet">
        <div className="flex flex-col items-center gap-1 px-4 py-10 text-center text-[15px] text-text2">
          <p className="font-display text-lg font-bold text-text">No report yet</p>
          <p>
            Oracle makes one every week for the week that ended.
            {canGenerate ? " You can generate one now for the week so far." : " An owner can generate one now."}
          </p>
          {canGenerate && (
            <div className="mt-3">
              <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
                Generate now
              </Button>
            </div>
          )}
        </div>
      </Panel>
      {open && <GenerateDialog onClose={() => setOpen(false)} />}
    </Page>
  );
}
