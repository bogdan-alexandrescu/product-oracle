"use client";

import { Button, Chip, Inspector, InspectorRow, InspectorSection } from "@/components/ds";

import { plural } from "@/lib/format";

import { DECIDED_BY, KNOWLEDGE, ORIGIN, PACK_POLICY, POLICY_SOURCE, ROLE, SELECTION_LABEL, missingInWords, reasonInWords, type Changes, type Module } from "./_lib";

/** Modules by name under their label, wrapping (never cut, never squeezing the label). */
function Names({ label, keys, titleOf }: { label: string; keys: string[]; titleOf: (key: string) => string }) {
  if (!keys.length) return <InspectorRow value={<span className="font-normal text-text2">None</span>}>{label}</InspectorRow>;
  return (
    <div className="py-1.5">
      <p>{label}</p>
      <p className="font-semibold [overflow-wrap:anywhere]">{keys.map(titleOf).join(", ")}</p>
    </div>
  );
}

/** A count of sections in words ("2 sections", "None"). */
function Sections({ keys }: { keys: string[] }) {
  return keys.length ? <span className="font-normal">{plural(keys.length, "section")}</span> : <span className="text-text2">None</span>;
}

/** A value in words: lists joined, yes/no, nothing as a dash (never raw JSON). */
function shown(v: unknown): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map(shown).join(", ") : "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${words(k)}: ${shown(x)}`).join("; ");
  return String(v).replace(/[_]/g, " ");
}

/** An input's path in words: "scope.capabilities" is "Capabilities (scope)". */
function words(path: string): string {
  const parts = path.split(".").map((p) => p.replace(/[_-]/g, " "));
  const last = parts.pop() ?? "";
  const head = last.charAt(0).toUpperCase() + last.slice(1);
  return parts.length ? `${head} (${parts.join(", ")})` : head;
}

const OP: Record<string, string> = {
  eq: "is",
  ne: "is not",
  in: "is one of",
  not_in: "is none of",
  contains: "includes",
  contains_any: "includes any of",
  contains_all: "includes all of",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  exists: "is given",
  missing: "is not given",
  truthy: "is set",
};

const IMPORTANCE: Record<string, string> = { critical: "Critical", high: "Important", medium: "Useful", low: "Nice to have" };

/**
 * The selected module (A's 380 px inspector): why it is here, what it rests on, missing
 * information, brief/full impact, dependencies, versions, the advisory score, and the
 * draft action. `canChange` is null for a reader (no action at all).
 */
export function ModuleDetail({
  m,
  changes,
  canChange,
  onToggle,
  onMove,
  titleOf,
  bare = false,
}: {
  m: Module;
  changes: Changes;
  /** May stage changes (an approver); null: read only. */
  canChange: boolean;
  onToggle: () => void;
  /** Moves it up (-1) or down (+1) in the draft's order; null where it cannot move that way. */
  onMove: { up: (() => void) | null; down: (() => void) | null } | null;
  /** A module key's name. */
  titleOf: (key: string) => string;
  /** In a phone sheet: the head is the sheet's. */
  bare?: boolean;
}) {
  // A mandatory module cannot be removed: no Remove is offered (an earlier staged removal can be undone).
  const mandatory = m.selection === "mandatory" && m.included && !changes.remove.includes(m.key);
  const staged = changes.add.includes(m.key) ? "add" : changes.remove.includes(m.key) ? "remove" : null;
  const versions = "versions" in m ? m.versions : [];
  const latest = "latest_version" in m ? m.latest_version : null;
  const upgrade = "upgrade_available" in m ? m.upgrade_available : null;
  const present = "sections_present" in m ? m.sections_present : [];
  const missing = "sections_missing" in m ? m.sections_missing : [];
  const chips = (
    <>
      <Chip kind="acc" hero={!bare}>
        {SELECTION_LABEL[m.selection]}
      </Chip>
      <Chip kind={m.included ? "pass" : "na"} hero={!bare}>
        {m.included ? "Included" : "Excluded"}
      </Chip>
      <Chip kind="line" hero={!bare}>
        {POLICY_SOURCE[m.policy_source]}
      </Chip>
      {m.required_review_role === "owner" && (
        <Chip kind="warn" hero={!bare}>
          Owner review
        </Chip>
      )}
    </>
  );
  const body = (
    <>
      <InspectorSection label="Why it is here">
        <p className="text-[15px]">{reasonInWords(m)}</p>
        <ul className="mt-2 space-y-1 text-sm text-text2">
          <li>
            Decided by: {DECIDED_BY[m.decided_by]} · {POLICY_SOURCE[m.policy_source]}
          </li>
          {m.explanation.map((e) => (
            <li key={e}>· {e}</li>
          ))}
          {m.user_reason && <li>“{m.user_reason}”</li>}
        </ul>
      </InspectorSection>
      {m.basis.length > 0 && (
        <InspectorSection label="What it rests on" testId="module-basis">
          <ul className="space-y-2.5">
            {m.basis.map((b, i) => (
              <li key={`${b.path}-${i}`} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium [overflow-wrap:anywhere]">
                    {words(b.path)} {OP[b.op] ?? b.op.replace(/_/g, " ")}
                    {b.op === "exists" || b.op === "missing" || b.op === "truthy" ? "" : ` ${shown(b.expected)}`}
                  </span>
                  <Chip kind={b.missing ? "warn" : b.holds ? "pass" : "na"}>{b.missing ? "Missing" : b.holds ? "Holds" : "Does not hold"}</Chip>
                </div>
                <p className="mt-0.5 text-text2">
                  Found: {shown(b.actual)} · {KNOWLEDGE[b.knowledge_state]}
                  {b.source ? ` · from ${b.source}` : ""}
                  {b.evidence_ids.length ? ` · ${plural(b.evidence_ids.length, "piece")} of evidence` : ""}
                </p>
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {(m.missing_information.length > 0 || m.questions.length > 0) && (
        <InspectorSection label="Missing information" testId="module-missing">
          <ul className="space-y-1.5 text-sm">
            {m.questions.map((q) => (
              <li key={q.key} className="flex items-start gap-2">
                <Chip kind={q.importance === "high" || q.importance === "critical" ? "warn" : "na"}>{IMPORTANCE[q.importance] ?? "Question"}</Chip>
                <span className="min-w-0">
                  {q.prompt} <span className="text-text2">· about {words(q.category).toLowerCase()}</span>
                </span>
              </li>
            ))}
            {m.missing_information.map((x) => (
              <li key={x} className="text-text2">
                {missingInWords(x)}
              </li>
            ))}
          </ul>
        </InspectorSection>
      )}
      {(m.field_problems.length > 0 || m.condition_error) && (
        <InspectorSection label="Problems" testId="module-problems">
          <ul className="space-y-1.5 text-sm">
            {m.field_problems.map((p) => (
              <li key={`${p.field}-${p.kind}`}>
                <span className="font-medium">{words(p.field)}</span> · {p.message}
              </li>
            ))}
            {m.condition_error && (
              <li>
                <span className="font-medium">When it applies could not be checked</span> · {m.condition_error}
              </li>
            )}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection label="Brief and full layout">
        <InspectorRow value={<Sections keys={m.layer_impact.brief_sections} />}>In the brief</InspectorRow>
        <InspectorRow value={<Sections keys={m.layer_impact.full_sections} />}>In the full version</InspectorRow>
        {m.layer_impact.new_sections.length > 0 && <InspectorRow value={<Sections keys={m.layer_impact.new_sections} />}>Added to the template</InspectorRow>}
        {m.layer_impact.absent_template_sections.length > 0 && (
          <InspectorRow value={<Sections keys={m.layer_impact.absent_template_sections} />}>Not in the template</InspectorRow>
        )}
        {missing.length > 0 && <InspectorRow value={<Sections keys={missing} />}>Missing from the latest version</InspectorRow>}
        {present.length > 0 && <InspectorRow value={<Sections keys={present} />}>In the latest version</InspectorRow>}
      </InspectorSection>
      <InspectorSection label="Dependencies and conflicts">
        <Names label="Depends on" keys={m.depends_on} titleOf={titleOf} />
        <Names label="Required by" keys={m.required_by} titleOf={titleOf} />
        <Names label="Conflicts with" keys={m.conflicts_with} titleOf={titleOf} />
      </InspectorSection>
      <InspectorSection label="Version">
        <InspectorRow value={ORIGIN[m.origin] ?? "Company module"}>Source</InspectorRow>
        {(upgrade || (latest && latest !== m.version)) && <InspectorRow value="Yes">Newer version available</InspectorRow>}
        {versions.length > 1 && <p className="mt-1 text-sm text-text2">{plural(versions.length, "version")} in the catalog</p>}
      </InspectorSection>
      {m.score != null && (
        <InspectorSection label="Advisory score">
          <p className="tnum text-[15px] font-semibold">{m.score.toFixed(2)}</p>
          <p className="text-sm text-text2">The score is shown for context and never decides.</p>
        </InspectorSection>
      )}
      {canChange && (
        <InspectorSection>
          <div className="flex flex-wrap items-center gap-2">
            {mandatory ? null : (
              <Button variant={staged ? "ghost" : m.included ? "danger" : "solid"} disabled={!m.can_change} onClick={onToggle}>
                {staged ? "Undo" : m.included ? "Remove from draft" : "Add to draft"}
              </Button>
            )}
            {onMove && (
              <>
                <Button disabled={!onMove.up} onClick={() => onMove.up?.()}>
                  Move up
                </Button>
                <Button disabled={!onMove.down} onClick={() => onMove.down?.()}>
                  Move down
                </Button>
              </>
            )}
            {mandatory && (
              <span data-testid="module-mandatory" className="text-sm text-text2">
                Mandatory: it stays in the PRD. Change the company policy to make it optional first.
              </span>
            )}
            {!mandatory && !m.can_change && <span className="text-sm text-text2">Your role cannot add or remove it: it needs the {ROLE[m.required_review_role] ?? "Owner"} role.</span>}
          </div>
        </InspectorSection>
      )}
    </>
  );
  if (bare) {
    return (
      <div data-testid="module-inspector">
        <div className="flex flex-wrap gap-2 px-4 pt-3">{chips}</div>
        {body}
      </div>
    );
  }
  return (
    <Inspector
      testId="module-inspector"
      eyebrow={`Module · ${PACK_POLICY[m.policy] ?? m.policy} · ${ORIGIN[m.origin] ?? "Company module"}`}
      title={m.title}
      chips={chips}
      stats={[
        { label: "In brief", value: m.layer_impact.brief_sections.length },
        { label: "In full", value: m.layer_impact.full_sections.length },
        { label: "Added", value: m.layer_impact.new_sections.length },
      ]}
    >
      {body}
    </Inspector>
  );
}
