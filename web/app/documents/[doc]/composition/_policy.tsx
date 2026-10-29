"use client";

import { useState } from "react";

import { Button, Chip, Empty, Inspector, InspectorSection, Notice, Panel, SegmentedControl, Sheet, Split } from "@/components/ds";
import { ErrorNote, Loading } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { CatalogFacts } from "./_catalog";
import { PACK_POLICY, type Module, type Problem } from "./_lib";

type Entry = Schemas["CatalogModuleOut"];
type Settings = Schemas["ModulePolicySettings"];
type Lane = "required" | "optional" | "disabled" | "pack";

const MAX_PACKS = 10;

const LANES: { lane: Lane; title: string; hint: string }[] = [
  { lane: "required", title: "Required", hint: "Mandatory in every PRD; overrides packs and templates." },
  { lane: "optional", title: "Optional", hint: "Never mandatory, even if a pack requires it." },
  { lane: "disabled", title: "Disabled", hint: "Cannot be added to any PRD." },
  { lane: "pack", title: "Follows pack", hint: "No company policy: pack or template decides." },
];

function laneOf(p: Settings, key: string): Lane {
  if (p.required.includes(key)) return "required";
  if (p.optional.includes(key)) return "optional";
  if (p.disabled.includes(key)) return "disabled";
  return "pack";
}

function moved(p: Settings, key: string, to: Lane): Settings {
  const out = (xs: string[]) => xs.filter((k) => k !== key);
  const next = { ...p, required: out(p.required), optional: out(p.optional), disabled: out(p.disabled) };
  if (to !== "pack") next[to] = [...next[to], key];
  return next;
}

/**
 * C's policy board as A's Company policy tab: the catalog in four lanes, the default packs
 * on top, an inspector per catalog entry. Owners move modules and save (PUT /v1/module-policy);
 * everyone else reads it.
 */
export function PolicyTab({ phone, onSaved, prdModules, prdTitle }: { phone: boolean; onSaved: () => void; prdModules: Module[]; prdTitle: string }) {
  const { can } = useMe();
  const owner = can("put_module_policy");
  const policyQ = useQuery("module-policy", () => unwrap(api.GET("/v1/module-policy")));
  const catalogQ = useQuery("module-catalog", () => unwrap(api.GET("/v1/module-catalog")));
  const packsQ = useQuery("module-packs", () => unwrap(api.GET("/v1/module-packs")));
  const [edit, setEdit] = useState<Settings | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  const error0 = policyQ.error ?? catalogQ.error ?? packsQ.error;
  if (error0) return <ErrorNote>{error0}</ErrorNote>;
  if (!policyQ.data || !catalogQ.data || !packsQ.data) return <Loading />;
  const saved = policyQ.data;
  const policy: Settings = edit ?? saved;
  const catalog = catalogQ.data;
  const packs = packsQ.data;
  const dirty = edit !== null && JSON.stringify(edit) !== JSON.stringify({ required: saved.required, optional: saved.optional, disabled: saved.disabled, default_packs: saved.default_packs });
  const selected = catalog.find((e) => e.key === picked) ?? null;
  const inPrd = (key: string) => prdModules.find((m) => m.key === key);

  function change(next: Settings) {
    setEdit(next);
    setResult(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setProblems([]);
    const body: Settings = { required: policy.required, optional: policy.optional, disabled: policy.disabled, default_packs: policy.default_packs };
    const res = await api.PUT("/v1/module-policy", { body });
    const err = res.error as { problems?: Problem[] } | undefined;
    if (res.response.status === 422 && err && Array.isArray(err.problems)) {
      setProblems(err.problems);
      setBusy(false);
      return;
    }
    try {
      const out = await unwrap(Promise.resolve(res));
      policyQ.setData(() => out);
      setEdit(null);
      onSaved();
      setResult("Policy saved. Compositions in force are not changed: each PRD applies it when someone confirms a new revision.");
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  }

  const togglePack = (id: string) => {
    const on = policy.default_packs.includes(id);
    change({ ...policy, default_packs: on ? policy.default_packs.filter((p) => p !== id) : [...policy.default_packs, id] });
  };

  const detail = (bare: boolean) => {
    if (!selected) return null;
    const lane = laneOf(policy, selected.key);
    const was = laneOf(saved, selected.key);
    const body = (
      <>
        {selected.description && (
          <InspectorSection label="Description">
            <p className="text-[15px]">{selected.description}</p>
          </InspectorSection>
        )}
        <InspectorSection label="Company policy">
          {owner ? (
            <>
              <SegmentedControl
                label="Move to"
                size="sm"
                value={lane}
                onChange={(to) => change(moved(policy, selected.key, to))}
                items={[
                  { value: "required", label: "Required" },
                  { value: "optional", label: "Optional" },
                  { value: "disabled", label: "Disabled" },
                  { value: "pack", label: "None" },
                ]}
              />
              {lane !== was && <p className="mt-1.5 text-sm text-text2">Was: {LANES.find((l) => l.lane === was)!.title}. A key may sit in one list only.</p>}
            </>
          ) : (
            <p className="text-[15px]">{LANES.find((l) => l.lane === lane)!.title}</p>
          )}
        </InspectorSection>
        <CatalogFacts e={selected} />
      </>
    );
    if (bare) return <div data-testid="policy-inspector">{body}</div>;
    return (
      <Inspector
        testId="policy-inspector"
        eyebrow={`Catalog module · ${selected.builtin ? "Built-in" : "Company module"}`}
        title={selected.title}
        chips={
          <>
            <Chip kind="line" hero>
              Pack policy: {PACK_POLICY[selected.policy] ?? selected.policy}
            </Chip>
            {lane !== was && <Chip kind="warn" hero>Unsaved</Chip>}
          </>
        }
      >
        {body}
      </Inspector>
    );
  };

  const card = (e: Entry) => {
    const m = inPrd(e.key);
    const on = e.key === picked;
    return (
      <button
        key={e.key}
        type="button"
        data-module={e.key}
        aria-pressed={on}
        onClick={() => {
          setPicked(e.key);
          if (phone) setSheet(true);
        }}
        className={`flex w-full min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left ${on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface2"}`}
      >
        <span className="flex w-full min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{e.title}</span>
          {laneOf(policy, e.key) !== laneOf(saved, e.key) && <Chip kind="warn">Unsaved</Chip>}
          {e.required_review_role === "owner" && <Chip kind="na">Owner review</Chip>}
          {e.archived && <Chip kind="na">Archived</Chip>}
        </span>
        <span className="text-sm text-text2">Pack policy: {PACK_POLICY[e.policy] ?? e.policy}</span>
        <span className="text-sm text-text2">
          {prdTitle}: {m ? (m.included ? "included" : "excluded") : "not offered"}
        </span>
      </button>
    );
  };

  return (
    <Split inspector={!phone && selected ? detail(false) : undefined}>
      <Panel
        testId="policy-board"
        title="Company policy"
        tools={
          owner ? (
            <>
              {dirty && <Chip kind="warn">Unsaved changes</Chip>}
              <Button variant="ghost" disabled={!dirty || busy} onClick={() => setEdit(null)}>
                Discard
              </Button>
              <Button variant="solid" disabled={!dirty || busy} onClick={save}>
                Save policy
              </Button>
            </>
          ) : (
            <Chip kind="na">Owner edits policy</Chip>
          )
        }
        bodyClassName="space-y-4 p-4 max-[600px]:p-3"
      >
        <p className="text-sm text-text2">
          {saved.is_default ? "No company policy yet. Packs and templates decide every module." : saved.updated_at ? `Updated ${formatDate(saved.updated_at)}.` : null}{" "}
          Saving changes no composition in force; each PRD applies it when someone confirms a new revision.
        </p>
        {result && (
          <Notice tone="pass" testId="policy-result">
            {result}
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {problems.length > 0 && (
          <div role="alert" className="space-y-1 rounded-button bg-crit-bg px-3 py-2 text-sm text-crit">
            {problems.map((p, i) => (
              <p key={i}>{p.message}</p>
            ))}
          </div>
        )}
        <section aria-label="Default packs">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-bold">Default packs</h3>
            <span className="tnum text-sm text-text2">
              {policy.default_packs.length} of {MAX_PACKS} · used when a request chooses none
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {packs.map((p) => {
              const on = policy.default_packs.includes(p.id);
              const full = !on && policy.default_packs.length >= MAX_PACKS;
              return owner ? (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  disabled={full}
                  title={full ? "At most 10 default packs. Remove one to add another." : undefined}
                  onClick={() => togglePack(p.id)}
                  className={`flex min-h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm max-[600px]:min-h-11 ${on ? "border-accent bg-accent text-on-accent" : "border-line-strong bg-surface text-text hover:bg-surface2"} disabled:opacity-60`}
                >
                  <span className="[overflow-wrap:anywhere]">{p.title}</span>
                </button>
              ) : on ? (
                <Chip key={p.id} kind="acc">
                  {p.title}
                </Chip>
              ) : null;
            })}
            {!owner && policy.default_packs.length === 0 && <span className="text-sm text-text2">None: the category decides.</span>}
          </div>
        </section>
        <div className="grid gap-3 min-[1600px]:grid-cols-4 min-[601px]:grid-cols-2">
          {LANES.map(({ lane, title, hint }) => {
            const inLane = catalog.filter((e) => laneOf(policy, e.key) === lane);
            return (
              <section key={lane} data-testid={`lane-${lane}`} aria-label={title} className="min-w-0 rounded-panel border border-line bg-surface2 p-2.5">
                <div className="flex items-center gap-2 px-1">
                  <h3 className="font-display text-base font-bold">{title}</h3>
                  <span className="tnum text-sm font-semibold text-accent-ink">{inLane.length}</span>
                </div>
                <p className="mb-2 px-1 text-[13px] text-text2">{hint}</p>
                <div className="flex flex-col gap-2">{inLane.length ? inLane.map(card) : <Empty>No modules</Empty>}</div>
              </section>
            );
          })}
        </div>
      </Panel>
      {phone && selected && (
        <Sheet open={sheet} title={selected.title} onClose={() => setSheet(false)}>
          {detail(true)}
        </Sheet>
      )}
    </Split>
  );
}
