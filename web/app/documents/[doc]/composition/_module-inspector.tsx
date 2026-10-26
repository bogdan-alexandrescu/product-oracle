"use client";

import { Button, Chip, Inspector, InspectorRow, InspectorSection } from "@/components/ds";

import { DECIDED_BY, KNOWLEDGE, POLICY_SOURCE, SELECTION_LABEL, type Changes, type Module } from "./_lib";

const MONO = "font-mono text-[13px]";

function Keys({ keys }: { keys: string[] }) {
  if (!keys.length) return <span className="text-text2">—</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {keys.map((k) => (
        <span key={k} className={`${MONO} rounded border border-line px-1.5 font-normal`}>
          {k}
        </span>
      ))}
    </span>
  );
}

function shown(v: unknown): string {
  return v == null ? "—" : JSON.stringify(v);
}

/**
 * The selected module (A's 380 px inspector): why it is here, what it rests on, missing
 * information, brief/full impact, dependencies, versions, the advisory score, and the
 * draft action. `canChange` is null for a reader (no action at all).
 */
export function ModuleDetail({
  m,
  changes,
  canChange,
  ownerOnly,
  onToggle,
  onMove,
  bare = false,
}: {
  m: Module;
  changes: Changes;
  /** May stage changes (an approver); null: read only. */
  canChange: boolean;
  /** The module asks for the owner role and the caller does not have it. */
  ownerOnly: boolean;
  onToggle: () => void;
  /** Moves it up (-1) or down (+1) in the draft's order; null where it cannot move that way. */
  onMove: { up: (() => void) | null; down: (() => void) | null } | null;
  /** In a phone sheet: the head is the sheet's. */
  bare?: boolean;
}) {
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
        v{m.version}
      </Chip>
      <Chip kind="line" hero={!bare}>
        Policy: {m.policy_source}
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
        <p className="text-[15px]">{m.reason}</p>
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
                  <span className={MONO}>
                    {b.path} {b.op} {shown(b.expected)}
                  </span>
                  <Chip kind={b.missing ? "warn" : b.holds ? "pass" : "na"}>{b.missing ? "Missing" : b.holds ? "Holds" : "Does not hold"}</Chip>
                </div>
                <p className="mt-0.5 text-text2">
                  Read: <span className={MONO}>{shown(b.actual)}</span> · {KNOWLEDGE[b.knowledge_state]}
                  {b.source ? ` · source: ${b.source}` : ""}
                  {b.evidence_ids.length ? ` · evidence ${b.evidence_ids.join(", ")}` : ""}
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
                <Chip kind={q.importance === "high" ? "warn" : "na"}>{q.importance}</Chip>
                <span className="min-w-0">
                  {q.prompt} <span className="text-text2">· {q.category}</span>
                </span>
              </li>
            ))}
            {m.missing_information.map((x) => (
              <li key={x} className="text-text2">
                {x}
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
                <span className={MONO}>{p.field}</span> {p.kind} · {p.message}
              </li>
            ))}
            {m.condition_error && (
              <li>
                <span className={MONO}>condition_error</span> {m.condition_error}
              </li>
            )}
          </ul>
        </InspectorSection>
      )}
      <InspectorSection label="Brief / full layout">
        <InspectorRow value={<Keys keys={m.layer_impact.brief_sections} />}>Brief</InspectorRow>
        <InspectorRow value={<Keys keys={m.layer_impact.full_sections} />}>Full</InspectorRow>
        {m.layer_impact.new_sections.length > 0 && <InspectorRow value={<Keys keys={m.layer_impact.new_sections} />}>New to template</InspectorRow>}
        {m.layer_impact.absent_template_sections.length > 0 && (
          <InspectorRow value={<Keys keys={m.layer_impact.absent_template_sections} />}>Not in template</InspectorRow>
        )}
        {missing.length > 0 && <InspectorRow value={<Keys keys={missing} />}>Missing from latest version</InspectorRow>}
        {present.length > 0 && <InspectorRow value={<Keys keys={present} />}>In latest version</InspectorRow>}
      </InspectorSection>
      <InspectorSection label="Dependencies & conflicts">
        <InspectorRow value={<Keys keys={m.depends_on} />}>Depends on</InspectorRow>
        <InspectorRow value={<Keys keys={m.required_by} />}>Required by</InspectorRow>
        <InspectorRow value={<Keys keys={m.conflicts_with} />}>Conflicts with</InspectorRow>
      </InspectorSection>
      <InspectorSection label="Version">
        <InspectorRow value={`${m.version} · ${m.origin}`}>In use</InspectorRow>
        {latest && <InspectorRow value={latest}>Latest</InspectorRow>}
        {upgrade && <InspectorRow value={upgrade}>Upgrade available</InspectorRow>}
        {versions.length > 1 && (
          <ul className="mt-1 text-sm text-text2">
            {versions.map((v) => (
              <li key={v.version}>
                {v.version} · {v.origin}
              </li>
            ))}
          </ul>
        )}
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
            <Button variant={staged ? "ghost" : m.included ? "danger" : "solid"} disabled={ownerOnly} onClick={onToggle}>
              {staged ? "Undo" : m.included ? "Remove from draft" : "Add to draft"}
            </Button>
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
            {ownerOnly && <span className="text-sm text-text2">Requires the owner role</span>}
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
      eyebrow={`Module · ${m.policy} · ${m.origin}`}
      title={m.title}
      chips={chips}
      stats={[
        { label: "Brief sections", value: m.layer_impact.brief_sections.length },
        { label: "Full sections", value: m.layer_impact.full_sections.length },
        { label: "New to template", value: m.layer_impact.new_sections.length },
      ]}
    >
      {body}
    </Inspector>
  );
}
