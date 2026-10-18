"use client";

import type { ReactNode } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { problemText, type Problem } from "@/lib/api/problems";
import { useLive } from "@/lib/use-live";

export type TemplateCheck = Schemas["TemplateValidateOut"];

/** A minimal body that passes validation: what "New template" starts from. */
export const TEMPLATE_SKELETON = `---
theme: clean-document
suggest_when: "Describe when this template is the right pick"
brief: [problem, solution]
---

# <Title> {#title}

## Problem {#problem}
<!-- The customer problem, in the customer's terms. -->

## Solution {#solution}
<!-- What we will build, as conclusions. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. -->
`;

/** Validation problems of a template body, with line numbers. */
export function ProblemList({ problems, testId = "problems" }: { problems: Problem[]; testId?: string }) {
  return (
    <ul data-testid={testId} className="space-y-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      {problems.map((p, i) => (
        <li key={i}>{problemText(p)}</li>
      ))}
    </ul>
  );
}

/** Findings on a body or a stored version that do not block anything by themselves. */
export function WarningList({ warnings }: { warnings: Problem[] }) {
  return (
    <ul data-testid="template-warnings" className="mt-1 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {warnings.map((w, i) => (
        <li key={i}>{problemText(w)}</li>
      ))}
    </ul>
  );
}

/** How to fix `no_brief_sections` (O1g): every template marks the sections it presents. */
export function BriefFix() {
  return (
    <div data-testid="brief-fix" className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700">
      <p className="font-medium text-neutral-800">Mark the brief: the sections Present mode shows, one per slide. Either:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          list their ids in the front matter, e.g. <code className="font-mono text-xs">brief: [summary, problem, decisions]</code>
          ; or
        </li>
        <li>
          put a level-1 <code className="font-mono text-xs">{"# Full version {#full}"}</code> heading after them: the sections
          before it (except the title) are the brief.
        </li>
      </ul>
    </div>
  );
}

/**
 * Markdown editor of a template body, validated live (debounced) by
 * POST /v1/templates/validate. `children` renders below it with the latest check, so
 * the parent can disable its save button while the body is invalid or being checked.
 */
export function TemplateBodyEditor({
  value,
  onChange,
  label = "Body",
  rows = 22,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  rows?: number;
  children?: (state: { check: TemplateCheck | undefined; pending: boolean }) => ReactNode;
}) {
  const live = useLive(value, (body: string) => unwrap(api.POST("/v1/templates/validate", { body: { body } })), 400);
  const check = live.data;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-neutral-700" htmlFor="template-body">
        {label}
      </label>
      <textarea
        id="template-body"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px] leading-5 text-neutral-900"
      />
      <div aria-live="polite" className="min-h-6 text-sm">
        {live.error && <p className="text-rose-800">{live.error}</p>}
        {!check && !live.error && <p className="text-neutral-500">Checking…</p>}
        {check && check.valid && (
          <p data-testid="validation-ok" className="text-emerald-800">
            {live.pending ? "Checking…" : "Valid."} Sections: <span className="font-mono text-xs">{check.section_keys.join(", ")}</span>
            {check.suggested_theme && (
              <>
                {" "}
                · suggested theme <span className="font-mono text-xs">{check.suggested_theme}</span>
              </>
            )}
            {check.brief_sections.length > 0 && (
              <>
                {" "}
                · brief <span data-testid="brief-sections" className="font-mono text-xs">{check.brief_sections.join(", ")}</span>
              </>
            )}
          </p>
        )}
        {check && check.warnings.length > 0 && <WarningList warnings={check.warnings} />}
        {check && !check.valid && (
          <div className="space-y-1">
            <p className="font-medium text-rose-800">
              {check.problems.length} problem{check.problems.length > 1 ? "s" : ""} to fix before saving
              {live.pending ? " (checking…)" : ""}:
            </p>
            <ProblemList problems={check.problems} />
            {check.problems.some((p) => p.code === "no_brief_sections") && <BriefFix />}
          </div>
        )}
      </div>
      {children?.({ check, pending: live.pending })}
    </div>
  );
}
