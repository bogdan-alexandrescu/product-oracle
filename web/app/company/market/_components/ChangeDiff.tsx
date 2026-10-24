"use client";

import { useRef } from "react";

import { Button, Chip, useFocusTrap } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { useQuery } from "@/lib/use-query";

import { FindingCard } from "./FindingCard";
import { RATING_KIND, RATING_LABEL, day, originOf, type ChangeDetail } from "./lib";

/**
 * One change, over the page: a page change's diff (removed lines struck through, added lines
 * highlighted, both plain text: a URL in a competitor's page is never a link), or the web
 * finding a person promoted.
 */
export function ChangeDiff({ id, onClose }: { id: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, true, onClose);
  const zone = useCompanyZone();
  const q = useQuery(`competitor-change|${id}`, () => unwrap(api.GET("/v1/competitor-changes/{change_id}", { params: { path: { change_id: id } } })));
  const ch: ChangeDetail | undefined = q.data;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-hero/50 px-4 py-10 max-[600px]:px-2 max-[600px]:py-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-diff-title"
        tabIndex={-1}
        data-testid="change-diff"
        className="w-full max-w-2xl min-w-0 rounded-inspector border border-line bg-surface text-text shadow-tip outline-none"
      >
        <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-line px-5 py-2 max-[600px]:px-4">
          <h2 id="change-diff-title" className="min-w-0 font-display text-xl font-bold tracking-heading [overflow-wrap:anywhere]">
            {ch ? `${ch.competitor_name} · ${originOf(ch)}` : "Change"}
          </h2>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4 max-[600px]:px-4">
          {q.error && <ErrorNote>{q.error}</ErrorNote>}
          {!ch && !q.error && <Loading />}
          {ch && (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm text-text2">
                <span className="tnum">Found {day(ch.detected_at, zone)}</span>
                {ch.origin === "page" && (
                  <span className="tnum">
                    +{ch.added_lines} −{ch.removed_lines} lines
                  </span>
                )}
                <Chip kind={RATING_KIND[ch.rating]}>{RATING_LABEL[ch.rating]}</Chip>
                {ch.page_url && <span className="min-w-0 [overflow-wrap:anywhere]">{ch.page_url}</span>}
              </p>
              {ch.summary && <p className="text-[15px] [overflow-wrap:anywhere]">{ch.summary}</p>}
              {ch.origin === "page" ? (
                <ol aria-label="Lines removed and added" className="flex flex-col gap-0.5 rounded-lg border border-line p-2 font-mono text-[13px]">
                  {ch.diff.length === 0 && <li className="text-text2">No lines kept for this change</li>}
                  {ch.diff.map((line, i) => (
                    <li
                      key={i}
                      data-op={line.op}
                      className={`flex min-w-0 gap-2 rounded px-1.5 py-0.5 whitespace-pre-wrap [overflow-wrap:anywhere] ${
                        line.op === "+" ? "bg-pass-bg text-pass" : "bg-crit-bg text-crit"
                      }`}
                    >
                      <span aria-hidden className="flex-none select-none">
                        {line.op === "+" ? "+" : "−"}
                      </span>
                      {line.op === "+" ? <ins className="min-w-0 no-underline">{line.text}</ins> : <del className="min-w-0">{line.text}</del>}
                    </li>
                  ))}
                </ol>
              ) : (
                ch.web_finding && <FindingCard finding={ch.web_finding} canDecide={false} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
