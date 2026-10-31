"use client";

import { useState } from "react";

import { Button, Chip, Icon, InfoTip, Notice, PageHeader, Panel, Sheet, ViewOnly } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
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
/** Whether Act's limits have anything an owner can change; all fixed, they are shown, not edited (qa-settings-34). */
const limitsEditable = (item: Item) => !!item.limits_schema && Object.values(propsOf(item)).some((p) => !p.fixed);

/** qa4-settings-44: a share between 0 and 1 (a confidence) is asked for as a percent. */
const isShare = (p: Prop) => p.type === "number" && p.minimum !== undefined && p.maximum !== undefined && p.minimum >= 0 && p.maximum <= 1;
const pct = (v: number) => Number((v * 100).toFixed(4));
/** Why a number limit can't be saved as typed, or null: empty, not whole, or out of range. */
function limitProblem(p: Prop, v: unknown): string | null {
  // Not touched: the API keeps its default.
  if (p.fixed || p.type === "array" || p.type === "boolean" || v === undefined) return null;
  const share = isShare(p);
  const lo = p.minimum === undefined ? undefined : share ? pct(p.minimum) : p.minimum;
  const hi = p.maximum === undefined ? undefined : share ? pct(p.maximum) : p.maximum;
  const unit = share ? " %" : "";
  const range = lo !== undefined && hi !== undefined ? `from ${lo} to ${hi}${unit}` : lo !== undefined ? `of ${lo}${unit} or more` : hi !== undefined ? `up to ${hi}${unit}` : "";
  const ask = `Enter a ${p.type === "integer" ? "whole number" : "number"}${range ? ` ${range}` : ""}.`;
  if (typeof v !== "number" || Number.isNaN(v)) return ask;
  if (p.type === "integer" && !Number.isInteger(v)) return ask;
  if ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum)) return ask;
  return null;
}

/** The steps above a responsibility's ceiling, in words: "Recommend and Act". */
function lockedLabels(item: Item): string | null {
  const names = LEVELS.filter((l) => !item.allowed.includes(l.value)).map((l) => l.label);
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Settings › Autonomy (H11): how far Oracle goes on its own, per responsibility. Everyone
 * reads it; only an owner changes a level, in a sheet that says what changes and asks why.
 * Other roles see each level as a chip, and View only (#370).
 */
export function AutonomySettings() {
  const q = useQuery("autonomy", () => unwrap(api.GET("/v1/autonomy")));
  const { can, capsReady } = useMe();
  const owner = can("set_autonomy");
  const [change, setChange] = useState<{ item: Item; level: Level } | null>(null);
  const [saved, setSaved] = useState(false);
  const items = q.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Autonomy"
        info={
          <InfoTip label="autonomy" align="start" side="bottom">
            {/* qa-settings-11: the page's intro in its tip, as on every Settings tab. */}
            <span className="block">How far Oracle goes on its own. You can change this any time.</span>
            {LEVELS.map((l) => (
              <span key={l.value} className="block">
                <b>{l.title}:</b> {LEVEL_COPY[l.value]}
              </span>
            ))}
          </InfoTip>
        }
        status={capsReady && !owner && <ViewOnly />}
      />
      <div className="flex flex-col gap-4 max-[600px]:gap-3">
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
  // qa4-settings-45: why a step is locked, said in text (and tied to the locked buttons), not only in a tooltip.
  const locked = owner ? lockedLabels(item) : null;
  const lockedId = `autonomy-locked-${item.key}`;
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
      {owner ? (
        <Steps item={item} onPick={onPick} describedBy={locked ? lockedId : undefined} />
      ) : (
        <Chip kind="acc" data-testid="autonomy-level">
          {LEVELS.find((l) => l.value === item.level)?.label ?? item.level}
        </Chip>
      )}
      <p className="col-span-full flex min-w-0 flex-wrap items-center gap-x-2 text-[15px] text-text2">
        <span data-testid="autonomy-sentence">{item.levels[item.level]}</span>
        {showLimits && (
          <Chip kind="acc" data-testid="autonomy-limits" title={item.limits_summary ?? undefined}>
            <span className="truncate">{item.limits_summary}</span>
          </Chip>
        )}
        {owner && item.level === "act" && limitsEditable(item) && (
          <Button variant="ghost" onClick={() => onPick("act")}>
            Edit limits
          </Button>
        )}
      </p>
      {locked && (
        <p id={lockedId} data-testid="autonomy-locked" className="col-span-full flex min-w-0 items-center gap-1.5 text-sm text-text2">
          <Icon name="lock" size={16} />
          <span>
            {locked} {locked.includes(" and ") ? "stay" : "stays"} with people
            {item.ceiling_reason ? `: ${item.ceiling_reason}` : ""}.
          </span>
        </p>
      )}
    </li>
  );
}

/*
 * The same columns on every row (qa-settings-35): a row with a locked step is no wider, so
 * every control starts and ends at the same x, right-aligned on a wide screen and full width
 * on a phone. The shares follow the labels' lengths, with room for the lock.
 */
const STEP_COLUMNS =
  "grid w-[400px] flex-none grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1.4fr)_minmax(0,0.75fr)] max-[600px]:w-full";

/** Observe · Draft · Recommend · Act: one line, steps above the ceiling locked. */
function Steps({ item, onPick, describedBy }: { item: Item; onPick: (level: Level) => void; describedBy?: string }) {
  return (
    <div
      role="group"
      aria-label={`${item.title}: level`}
      data-testid="autonomy-steps"
      className={`${STEP_COLUMNS} justify-self-end overflow-hidden rounded-button border border-line-strong bg-surface max-[600px]:justify-self-stretch`}
    >
      {LEVELS.map((l) => {
        const on = item.level === l.value;
        const locked = !item.allowed.includes(l.value);
        // The current level is already set: picking it again does nothing (Edit limits changes Act's limits).
        const idle = on;
        return (
          <button
            key={l.value}
            type="button"
            aria-pressed={on}
            disabled={locked}
            aria-describedby={locked ? describedBy : undefined}
            title={locked ? `Stays with people: ${item.ceiling_reason ?? "above this responsibility's ceiling"}` : undefined}
            onClick={() => !idle && onPick(l.value)}
            className={`flex h-8 min-w-0 items-center justify-center gap-1 border-r border-line px-1 text-sm font-medium whitespace-nowrap last:border-r-0 max-[600px]:gap-0.5 ${
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
  const editLimits = level === "act" && limitsEditable(item);
  const problems = editLimits
    ? Object.fromEntries(Object.entries(props).map(([name, p]) => [name, limitProblem(p, limits[name])]).filter(([, m]) => m))
    : {};
  const invalid = Object.keys(problems).length > 0;

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
    <Sheet open dialog title={`Change ${item.title}`} onClose={onClose} testId="autonomy-sheet">
      <div className="flex w-full flex-col gap-3 px-4 py-3 text-[15px]">
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
                <Field key={name} label={isShare(p) ? `${p.title ?? name} (%)` : (p.title ?? name)}>
                  <span className="flex items-center gap-2">
                    <input
                      type="number"
                      className={`${INPUT} max-w-40`}
                      min={isShare(p) ? pct(p.minimum!) : p.minimum}
                      max={isShare(p) ? pct(p.maximum!) : p.maximum}
                      step={p.type === "integer" || isShare(p) ? 1 : "any"}
                      aria-invalid={problems[name] ? true : undefined}
                      value={
                        typeof limits[name] === "number" ? String(isShare(p) ? pct(limits[name] as number) : limits[name]) : ""
                      }
                      onChange={(e) =>
                        setLimits({
                          ...limits,
                          [name]: e.target.value === "" ? null : isShare(p) ? Number(e.target.value) / 100 : Number(e.target.value),
                        })
                      }
                    />
                    {isShare(p) && <span className="text-text2">%</span>}
                  </span>
                  {problems[name] && (
                    <span role="alert" data-testid="autonomy-limit-error" className="text-[13px] font-medium text-crit">
                      {problems[name]}
                    </span>
                  )}
                </Field>
              ),
            )}
          </fieldset>
        )}
        {/* qa4-settings-45: Why is required, and says so. */}
        <Field label="Why (required)">
          <textarea
            className={TEXTAREA}
            rows={3}
            value={why}
            required
            aria-required
            onChange={(e) => setWhy(e.target.value)}
            data-autofocus
          />
        </Field>
        {!why.trim() && (
          <p data-testid="autonomy-why-hint" className="-mt-1 text-[13px] text-text2">
            Say why to save: it is kept with the change.
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2 pb-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !why.trim() || invalid} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
