"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Field, Frame } from "@/components/DateBasisDialog";
import { Button, Notice, SegmentedControl, type ChipKind } from "@/components/ds";
import { PersonPicker, type Person } from "@/components/PersonPicker";
import { sizeText } from "@/components/tech-brief";
import { INPUT } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage, useQuery } from "@/lib/use-query";

export type SpecSummary = Schemas["SpecSummary"];
type EntityRef = Schemas["EntityRef"];
type Depth = Schemas["SpecRequestCreate"]["depth"];

/** F5 lane 3: a spec's state (oracle.specs.schemas.SpecState) as the Plan and the PRD overview show it. */
export const SPEC_STATE: Record<SpecSummary["state"], { label: string; kind: ChipKind }> = {
  requested: { label: "Requested", kind: "na" },
  drafting: { label: "Drafting", kind: "now" },
  in_review: { label: "In review", kind: "acc" },
  approved: { label: "Approved", kind: "pass" },
  // qa4-docs-30: a spec is "stale" exactly when its latest version is potentially stale
  // (specs.service._state): said in the same words as a tech brief's freshness.
  stale: { label: "Potentially stale", kind: "warn" },
  failed: { label: "Run failed", kind: "crit" },
};

/** One PRD's spec requests, newest first (GET /v1/spec-requests?prd=). */
export function useSpecs(prd: string | null | undefined) {
  return useQuery(`spec-requests|prd|${prd}`, () =>
    prd ? unwrap(api.GET("/v1/spec-requests", { params: { query: { prd } } })) : Promise.resolve([] as SpecSummary[]),
  );
}

/** Where Open goes: the spec's latest version, or its run while it has none (Requested, Drafting, Run failed). */
export function specHref(s: SpecSummary): string {
  if (s.document_slug && s.latest_version != null) return `/documents/${s.document_slug}/v/${s.latest_version}`;
  return s.request.run_id ? `/runs/${s.request.run_id}` : `/documents/${s.document_slug}`;
}

/** What a spec is requested for: a roadmap item and its trace (its feature and requirements). */
export type SpecSubject = { key: string; title: string; feature?: EntityRef | null; requirements?: EntityRef[] };

/** The item's spec: the newest one for its feature, else the newest covering one of its requirements. */
export function specFor(specs: readonly SpecSummary[], item: SpecSubject): SpecSummary | null {
  const feature = item.feature?.id;
  const reqs = new Set((item.requirements ?? []).map((r) => r.id));
  return (
    (feature ? specs.find((s) => s.feature_id === feature) : undefined) ??
    specs.find((s) => !s.feature_id && s.request.requirement_ids.some((r) => reqs.has(r))) ??
    null
  );
}

const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

type Approvers = "leads" | "any" | "chosen";

/**
 * F5 lane 3 Request spec: the depth (#126's Tech brief or Full engineering spec), the
 * requirements pre-ticked from the item's trace, the engineering approvers (the engineering
 * leads by default, A3), user flows and wireframes (on, O2) and the feature's approved tech
 * brief (F5-1), which the spec must not contradict without saying so. Submitting drafts the
 * prd_to_spec run (POST /v1/spec-requests) and opens it for its estimate. From a PRD's
 * overview the item is picked first.
 */
export function RequestSpecDialog({
  prd,
  items,
  initialKey,
  onClose,
}: {
  prd: string;
  items: SpecSubject[];
  initialKey?: string;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const [key, setKey] = useState(initialKey ?? (items.length === 1 ? items[0].key : ""));
  const item = items.find((i) => i.key === key) ?? null;
  const [depth, setDepth] = useState<Depth>("brief");
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [approvers, setApprovers] = useState<Approvers>("leads");
  const [chosen, setChosen] = useState<Person[]>([]);
  const [design, setDesign] = useState(true);
  const [useBrief, setUseBrief] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const briefs = useQuery(`tech-briefs|${prd}`, () => unwrap(api.GET("/v1/tech-briefs", { params: { query: { prd } } })));
  const feature = item?.feature ?? null;
  const brief = feature
    ? ((briefs.data ?? []).find((b) => b.status === "approved" && (b.feature.entity_id === feature.id || b.feature.key === feature.key)) ?? null)
    : null;
  const requirements = item?.requirements ?? [];
  const ticked = requirements.filter((r) => !dropped.has(r.id));
  const ready = !!item && ticked.length > 0 && (approvers !== "chosen" || chosen.length > 0);

  function pick(k: string) {
    setKey(k);
    setDropped(new Set());
    setUseBrief(true);
  }

  async function submit() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const out = await unwrap(
        api.POST("/v1/spec-requests", {
          body: {
            prd,
            requirement_ids: ticked.map((r) => r.id),
            feature_id: feature?.id ?? null,
            depth,
            design,
            screens: 3,
            knobs: { depth: "standard", roles: {}, checkpoints: {} },
            // The engineering leads: the API's default when none is named.
            ...(approvers === "leads" ? {} : { engineering_approver_ids: approvers === "any" ? [] : chosen.map((p) => p.user_id) }),
            tech_brief_version_id: brief && useBrief ? brief.id : null,
          },
        }),
      );
      router.push(`/runs/${out.run_id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Frame title="Request an engineering spec" onClose={onClose} testId="request-spec-dialog">
      <p className="text-text2">Oracle drafts the spec from the approved PRD in a run. You see its estimate before it starts.</p>
      {!initialKey && (
        <Field label="Item" htmlFor={`${id}-item`}>
          <select id={`${id}-item`} className={INPUT} value={key} onChange={(e) => pick(e.target.value)}>
            <option value="">Choose an approved roadmap item</option>
            {items.map((i) => (
              <option key={i.key} value={i.key}>
                {i.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!initialKey && items.length === 0 && <Notice>This PRD has no approved roadmap item yet. Approve its roadmap first.</Notice>}
      <div>
        <p className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Depth</p>
        <SegmentedControl
          label="Depth"
          value={depth}
          onChange={setDepth}
          items={[
            { value: "brief", label: "Tech brief" },
            { value: "full", label: "Full engineering spec" },
          ]}
        />
      </div>
      {item && (
        <fieldset>
          <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Requirements</legend>
          {requirements.length === 0 ? (
            <Notice tone="warn">This item traces no requirement. Link its requirements in the Baseline first.</Notice>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {requirements.map((r) => (
                <li key={r.id}>
                  <label className="flex min-h-8 items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!dropped.has(r.id)}
                      onChange={(e) => {
                        const next = new Set(dropped);
                        if (e.target.checked) next.delete(r.id);
                        else next.add(r.id);
                        setDropped(next);
                      }}
                    />
                    <span className="min-w-0 break-words">{r.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-1.5 text-[13px] leading-4 font-semibold tracking-[0.02em] text-text2">Engineering approvers</legend>
        <div className="flex flex-col gap-1.5">
          {(
            [
              ["leads", "The engineering leads"],
              ["any", "Any approver"],
              ["chosen", "Choose people"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-8 items-center gap-2">
              <input type="radio" name={`${id}-approvers`} checked={approvers === value} onChange={() => setApprovers(value)} />
              {label}
            </label>
          ))}
        </div>
        {approvers === "leads" && <p className="mt-1 text-sm text-text2">Any approver when no engineering lead is named. An owner always may approve.</p>}
        {approvers === "chosen" && (
          <div className="mt-2 flex flex-col gap-2">
            {chosen.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {chosen.map((p) => (
                  <li key={p.user_id} className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-1 text-sm">
                    {p.name}
                    <button
                      type="button"
                      aria-label={`Remove ${p.name}`}
                      className="text-text2 hover:text-text"
                      onClick={() => setChosen(chosen.filter((x) => x.user_id !== p.user_id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <PersonPicker approversOnly exclude={chosen.map((p) => p.user_id)} onPick={(p) => setChosen([...chosen, p])} />
          </div>
        )}
      </fieldset>
      <label className="flex min-h-8 items-center gap-2">
        <input type="checkbox" checked={design} onChange={(e) => setDesign(e.target.checked)} />
        User flows and wireframes
      </label>
      {item && (
        <div data-testid="request-spec-brief" className="flex flex-col gap-1.5 rounded-button border border-line bg-surface2 px-3 py-2">
          {brief ? (
            <>
              <label className="flex min-h-8 items-center gap-2 font-semibold">
                <input type="checkbox" checked={useBrief} onChange={(e) => setUseBrief(e.target.checked)} />
                Use the approved tech brief
              </label>
              <p className="text-sm">
                {brief.verdict?.value ? sentence(brief.verdict.value) : "Approved at the Engineering check"} · {sizeText(brief.size)}{" "}
                <Link href={`/briefs/${brief.id}`} className="font-medium text-accent-ink hover:underline">
                  Read it
                </Link>
              </p>
              <p className="text-sm text-text2">The spec must not contradict what the engineering review decided without saying so.</p>
            </>
          ) : (
            <p className="text-sm text-text2">{briefs.data ? "No approved tech brief for this feature." : "…"}</p>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || busy} onClick={submit}>
          Request spec
        </Button>
      </div>
    </Frame>
  );
}
