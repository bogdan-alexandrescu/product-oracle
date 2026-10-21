"use client";

import { useState } from "react";

import { Button, Chip, Icon, InfoTip, Notice, PageHeader, Panel, Sheet } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { hasRole, useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { Field, INPUT, TEXTAREA } from "../_components/fields";

type Item = Schemas["AutonomyItem"];
type Level = Item["level"];

const LEVELS: { value: Level; label: string; title: string }[] = [
  { value: "observe", label: "Observe", title: "Observe" },
  { value: "draft", label: "Draft", title: "Draft" },
  { value: "recommend", label: "Recommend", title: "Recommend" },
  { value: "act", label: "Act", title: "Act within limits" },
];
const TITLE: Record<Level, string> = Object.fromEntries(LEVELS.map((l) => [l.value, l.title])) as Record<Level, string>;
/** What each level means (H11's Settings copy). */
const LEVEL_COPY: Record<Level, string> = {
  observe: "Oracle watches and flags. It makes nothing for you to act on.",
  draft: "Oracle writes a draft for a named person to edit and own.",
  recommend: "Oracle gives options with evidence and a default. A person decides.",
  act: "Oracle acts on reversible work inside your limits, then tells the owner.",
};
const GROUPS = ["knowledge", "planning", "documents", "operating", "outside"];

type Prop = { title?: string; type?: string; minimum?: number; maximum?: number; fixed?: boolean; items?: { enum?: string[] } };
const propsOf = (item: Item) => ((item.limits_schema?.properties ?? {}) as Record<string, Prop>);

/**
 * Settings › Autonomy (H11): how far Oracle goes on its own, per responsibility. Everyone
 * reads it; only an owner changes a level, in a sheet that says what changes and asks why.
 */
export function AutonomySettings() {
  const q = useQuery("autonomy", () => unwrap(api.GET("/v1/autonomy")));
  const { role } = useMe();
  const owner = hasRole(role, "owner");
  const [change, setChange] = useState<{ item: Item; level: Level } | null>(null);
  const [saved, setSaved] = useState(false);
  const items = q.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Autonomy"
        status={
          <InfoTip label="autonomy" align="start" side="bottom">
            {LEVELS.map((l) => (
              <span key={l.value} className="block">
                <b>{l.title}:</b> {LEVEL_COPY[l.value]}
              </span>
            ))}
          </InfoTip>
        }
      />
      <div className="flex flex-col gap-4 max-[600px]:gap-3">
        <p className="text-[15px] text-text2">How far Oracle goes on its own. You can change this any time.</p>
        {!owner && q.data && (
          <Notice testId="autonomy-owner-only">Only an owner can change this</Notice>
        )}
        {saved && <Notice tone="pass">Saved. Oracle follows this from now on.</Notice>}
        {q.error && <Notice tone="error">{q.error}</Notice>}
        {q.data &&
          GROUPS.map((g) => {
            const rows = items.filter((i) => i.group === g);
            if (rows.length === 0) return null;
            return (
              <Panel key={g} title={rows[0].group_title} testId={`autonomy-group-${g}`}>
                <ul>
                  {rows.map((item) => (
                    <Row
                      key={item.key}
                      item={item}
                      owner={owner}
                      onPick={(level) => {
                        setSaved(false);
                        setChange({ item, level });
                      }}
                    />
                  ))}
                </ul>
              </Panel>
            );
          })}
        {q.data && (
          <Panel title="Stays with people" testId="autonomy-stays">
            <div className="px-4 py-3 text-[15px] max-[600px]:px-3">
              <p className="text-text2">Oracle never decides these, at any setting.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {q.data.stays_with_people.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          </Panel>
        )}
      </div>
      {change && (
        <ChangeSheet
          item={change.item}
          level={change.level}
          onClose={() => setChange(null)}
          onSaved={async () => {
            setChange(null);
            setSaved(true);
            await q.reload();
          }}
        />
      )}
    </>
  );
}

function Row({ item, owner, onPick }: { item: Item; owner: boolean; onPick: (level: Level) => void }) {
  const showLimits = item.level === "act" && item.limits_summary;
  return (
    <li
      data-testid={`autonomy-row-${item.key}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-3 first:border-t-0 max-[600px]:grid-cols-1 max-[600px]:px-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-semibold">{item.title}</span>
        {!item.wired && (
          <Chip kind="line" data-testid="autonomy-pending" title={`Takes effect when ${item.wired_by_name} ships`}>
            <span className="truncate">Takes effect when {item.wired_by_name} ships</span>
          </Chip>
        )}
      </div>
      <Steps item={item} owner={owner} onPick={onPick} />
      <p className="col-span-full flex min-w-0 flex-wrap items-center gap-x-2 text-[15px] text-text2">
        <span data-testid="autonomy-sentence">{item.levels[item.level]}</span>
        {showLimits && (
          <Chip kind="acc" data-testid="autonomy-limits" title={item.limits_summary ?? undefined}>
            <span className="truncate">{item.limits_summary}</span>
          </Chip>
        )}
      </p>
    </li>
  );
}

/** Observe · Draft · Recommend · Act: one line, steps above the ceiling locked. */
function Steps({ item, owner, onPick }: { item: Item; owner: boolean; onPick: (level: Level) => void }) {
  return (
    <div role="group" aria-label={`${item.title}: level`} className="inline-flex flex-none rounded-button border border-line-strong bg-surface">
      {LEVELS.map((l) => {
        const on = item.level === l.value;
        const locked = !item.allowed.includes(l.value);
        // Picking the current level again only means something at Act: its limits.
        const idle = on && l.value !== "act";
        return (
          <button
            key={l.value}
            type="button"
            aria-pressed={on}
            disabled={locked || !owner}
            title={locked ? `Stays with people: ${item.ceiling_reason ?? "above this responsibility's ceiling"}` : undefined}
            onClick={() => !idle && onPick(l.value)}
            className={`flex h-8 items-center gap-1 border-r border-line px-3 text-sm font-medium whitespace-nowrap last:border-r-0 max-[600px]:px-2 ${
              on ? "bg-accent text-on-accent" : "text-text hover:bg-surface2"
            } disabled:cursor-not-allowed disabled:hover:bg-transparent ${on ? "" : "disabled:text-text2"}`}
          >
            {locked && <Icon name="lock" size={16} />}
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

function ChangeSheet({
  item,
  level,
  onClose,
  onSaved,
}: {
  item: Item;
  level: Level;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const props = propsOf(item);
  const [limits, setLimits] = useState<Record<string, unknown>>(() => ({ ...(item.limits ?? {}) }));
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editLimits = level === "act" && item.limits_schema;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const editable = editLimits
        ? Object.fromEntries(Object.entries(limits).filter(([k]) => !item.fixed_limits.includes(k)))
        : undefined;
      await unwrap(
        api.PUT("/v1/autonomy/{key}", {
          params: { path: { key: item.key } },
          body: { level, limits: editable && Object.keys(editable).length ? editable : null, reason: why.trim() },
        }),
      );
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open title={`Change ${item.title}`} onClose={onClose} testId="autonomy-sheet">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-4 py-3 text-[15px]">
        <p data-testid="autonomy-from">
          <span className="font-semibold">Now, {TITLE[item.level]}:</span> {item.levels[item.level]}
        </p>
        <p data-testid="autonomy-to">
          <span className="font-semibold">
            {level === item.level ? "Stays" : "Becomes"} {TITLE[level]}:
          </span>{" "}
          {item.levels[level]}
        </p>
        {editLimits && (
          <fieldset className="flex flex-col gap-3 rounded-button border border-line px-3 py-3">
            <legend className="px-1 text-[13px] font-semibold text-text2">Limits</legend>
            {Object.entries(props).map(([name, p]) =>
              p.fixed ? (
                <p key={name} className="text-text2">
                  {p.title} (fixed)
                </p>
              ) : p.type === "array" ? (
                <div key={name} role="group" aria-label={p.title} className="flex flex-wrap items-center gap-3">
                  <span className="text-[13px] font-semibold text-text2">{p.title}</span>
                  {(p.items?.enum ?? []).map((opt) => {
                    const list = (limits[name] as string[] | undefined) ?? [];
                    return (
                      <label key={opt} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={list.includes(opt)}
                          onChange={(e) =>
                            setLimits({ ...limits, [name]: e.target.checked ? [...list, opt] : list.filter((x) => x !== opt) })
                          }
                        />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <Field key={name} label={p.title ?? name}>
                  <input
                    type="number"
                    className={`${INPUT} max-w-40`}
                    min={p.minimum}
                    max={p.maximum}
                    step={p.type === "integer" ? 1 : "any"}
                    value={limits[name] === undefined || limits[name] === null ? "" : String(limits[name])}
                    onChange={(e) => setLimits({ ...limits, [name]: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </Field>
              ),
            )}
          </fieldset>
        )}
        <Field label="Why">
          <textarea className={TEXTAREA} rows={3} value={why} onChange={(e) => setWhy(e.target.value)} data-autofocus />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2 pb-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !why.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
