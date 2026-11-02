"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Chip, Notice, Panel } from "@/components/ds";
import { ErrorNote } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { errorMessage, type Query } from "@/lib/use-query";

import { NewRequestDialog } from "./NewRequest";

type Candidate = Schemas["CandidateOut"];
type Channel = Candidate["channel"];

const CHANNEL_LABEL: Record<Channel, string> = {
  support: "Support",
  sales: "Sales",
  team: "Team",
  slack: "Slack",
  meeting: "Meeting",
  doc: "Doc",
  other: "Other",
};

/**
 * Found in your sources (C1, decision S6): possible requests Oracle's triage spotted in the
 * signed-in person's own sources. Only they see them, and only while some are open. Each is
 * filed as a request (filing shares the item in full) or dismissed. File as request opens the
 * New request form filled in from the item (QD3 a, one form, two doors); the filed request
 * leaves the found list and opens, selected, in All requests (`onFiled`). `found` is the screen's
 * read of them (GET /v1/request-candidates?status=open), read again when a triage run ends, so
 * new finds show; the screen waits for it before drawing (qa4-work-13).
 */
export function FoundInSources({ found: q, onFiled }: { found: Query<Candidate[]>; onFiled: (request: Schemas["RequestOut"]) => void }) {
  const router = useRouter();
  const [filing, setFiling] = useState<Candidate | null>(null);
  const [filed, setFiled] = useState<Schemas["RequestOut"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = q.data ?? [];

  async function dismiss(c: Candidate) {
    setError(null);
    try {
      await unwrap(api.POST("/v1/request-candidates/{candidate_id}/dismiss", { params: { path: { candidate_id: c.id } } }));
      q.setData((rows) => rows?.filter((r) => r.id !== c.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      {filed && (
        <Notice tone="pass" testId="filed-notice">
          Filed &ldquo;{filed.title}&rdquo; as a new request.
        </Notice>
      )}
      {open.length > 0 && (
        <Panel testId="found-in-sources" title={`Oracle found ${plural(open.length, "possible request")} in your sources`}>
          <p className="px-4 pt-3 text-sm text-text2">Only you see these until you file one.</p>
          {error && (
            <div className="px-4 pt-2">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <ul className="divide-y divide-line">
            {open.map((c) => (
              <li key={c.id} data-testid="found-item" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-semibold" title={c.body ?? c.title}>
                    {c.title}
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-sm text-text2">
                    <Chip kind="line">{CHANNEL_LABEL[c.channel]}</Chip>
                    <span className="truncate">{c.source.title ?? "Untitled item"}</span>
                  </span>
                </div>
                <div className="flex flex-none gap-2">
                  <Button variant="solid" onClick={() => setFiling(c)}>
                    File as request
                  </Button>
                  <Button variant="ghost" onClick={() => dismiss(c)}>
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {filing && (
        <NewRequestDialog
          from={filing}
          onClose={() => setFiling(null)}
          onOpenExisting={(id) => {
            setFiling(null);
            router.push(`/requests?request=${encodeURIComponent(id)}`);
          }}
          onFiled={(request) => {
            setFiling(null);
            setFiled(request);
            q.setData((rows) => rows?.filter((r) => r.id !== filing.id));
            onFiled(request);
          }}
        />
      )}
    </>
  );
}
