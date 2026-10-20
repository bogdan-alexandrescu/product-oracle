"use client";

import type { ReactNode } from "react";

import { Chip, InfoTip, Label } from "@/components/ds";
import { TEXTAREA } from "@/app/settings/_components/fields";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { problemText, type Problem } from "@/lib/api/problems";
import { useLive, type Live } from "@/lib/use-live";

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

const validateBody = (body: string) => unwrap(api.POST("/v1/templates/validate", { body: { body } }));

/**
 * Live (debounced) validation of a template body by POST /v1/templates/validate. Call it in
 * the page when the save button sits outside the editor (top-right), and pass it as `live`.
 */
export function useTemplateCheck(value: string, enabled = true): Live<TemplateCheck> {
  return useLive(value, validateBody, 400, enabled);
}

/** Validation problems of a template body, with line numbers. */
export function ProblemList({ problems, testId = "problems" }: { problems: Problem[]; testId?: string }) {
  return (
    <ul data-testid={testId} className="space-y-1 rounded-button bg-crit-bg px-3 py-2 text-sm text-crit">
      {problems.map((p, i) => (
        <li key={i}>{problemText(p)}</li>
      ))}
    </ul>
  );
}

/** Findings on a body or a stored version that do not block anything by themselves. */
export function WarningList({ warnings }: { warnings: Problem[] }) {
  return (
    <ul data-testid="template-warnings" className="mt-1 space-y-1 rounded-button bg-warn-bg px-3 py-2 text-sm text-warn">
      {warnings.map((w, i) => (
        <li key={i}>{problemText(w)}</li>
      ))}
    </ul>
  );
}

/** How to fix `no_brief_sections` (O1g): every template marks the sections it presents. */
export function BriefFix() {
  return (
    <div data-testid="brief-fix" className="rounded-button border border-line bg-surface2 px-3 py-2 text-sm text-text">
      <p className="flex items-center gap-2 font-semibold">
        Mark the brief, either:
        <InfoTip label="the brief" align="start">
          The brief is the sections Present mode shows, one per slide.
        </InfoTip>
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          <code className="font-mono text-[13px]">brief: [summary, problem, decisions]</code> in the front matter
        </li>
        <li>
          <code className="font-mono text-[13px]">{"# Full version {#full}"}</code> after the brief sections
        </li>
      </ul>
    </div>
  );
}

/**
 * Markdown editor of a template body, validated live (debounced) by
 * POST /v1/templates/validate. `children` renders below it with the latest check, so
 * the parent can disable its save button while the body is invalid or being checked.
 * Pass `live` (from useTemplateCheck) when the parent needs the check itself.
 */
export function TemplateBodyEditor({
  value,
  onChange,
  label = "Body",
  rows = 22,
  live: given,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  rows?: number;
  live?: Live<TemplateCheck>;
  children?: (state: { check: TemplateCheck | undefined; pending: boolean }) => ReactNode;
}) {
  const own = useTemplateCheck(value, !given);
  const live = given ?? own;
  const check = live.data;
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5">
        <label className="text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2" htmlFor="template-body">
          {label}
        </label>
        <InfoTip label="template rules" align="start" side="bottom">
          Every heading ends with <code>{"{#id}"}</code>; the last section is{" "}
          <code>## Sources and data points {"{#sources}"}</code>. Saving adds a new version; documents keep the version they
          started from.
        </InfoTip>
      </span>
      <textarea
        id="template-body"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={`${TEXTAREA} font-mono text-sm leading-5`}
      />
      <div aria-live="polite" className="flex min-h-6 flex-col gap-2 text-sm">
        {live.error && <p className="text-crit">{live.error}</p>}
        {!check && !live.error && <p className="text-text2">Checking…</p>}
        {check && check.valid && (
          <p data-testid="validation-ok" className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip kind="pass" dot>
              {live.pending ? "Checking…" : "Valid."}
            </Chip>
            <Label>Sections:</Label>
            <span className="min-w-0 font-mono text-[13px] break-words">{check.section_keys.join(", ")}</span>
            {check.suggested_theme && (
              <>
                <Label>· theme</Label>
                <span className="font-mono text-[13px]">{check.suggested_theme}</span>
              </>
            )}
            {check.brief_sections.length > 0 && (
              <>
                <Label>· brief</Label>
                <span data-testid="brief-sections" className="font-mono text-[13px]">
                  {check.brief_sections.join(", ")}
                </span>
              </>
            )}
          </p>
        )}
        {check && check.warnings.length > 0 && <WarningList warnings={check.warnings} />}
        {check && !check.valid && (
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-2">
              <Chip kind="crit" dot>
                <span className="tnum">{check.problems.length}</span> problem{check.problems.length > 1 ? "s" : ""}
                {live.pending ? " · checking…" : ""}
              </Chip>
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
