"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Chip, InfoTip, Panel } from "@/components/ds";
import { ErrorNote, INPUT, Loading } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { useCompanyZone } from "@/lib/dates";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { FIELDS, day, type Positioning as PositioningOut, type Suggestion } from "./lib";

const ACTION_LABEL: Record<Suggestion["action"], string> = { add: "Add", replace: "Replace", remove: "Remove" };
const REF_LABEL: Record<Suggestion["refs"][number]["kind"], string> = { change: "Change", web: "From the web", request: "Request", source_item: "Source" };

/**
 * Market › Positioning: the company's six positioning inputs, each with the open suggestions
 * from the digest under it. Approvers and owners edit a field inline and Accept or Dismiss a
 * suggestion; the category and positioning bet stay with people (Oracle only suggests).
 */
export function Positioning() {
  const { can } = useMe();
  const zone = useCompanyZone();
  const q = useQuery("positioning", () => unwrap(api.GET("/v1/positioning")));
  if (q.error) return <ErrorNote>{q.error}</ErrorNote>;
  if (!q.data) return <Loading />;
  const data = q.data;
  const set = (out: PositioningOut) => q.setData(() => out);
  return (
    <Panel
      title="Positioning"
      tools={
        <InfoTip label="positioning" align="end">
          The company&apos;s positioning inputs. Oracle suggests changes from the monthly digest, with their evidence; a person accepts each one.
          Agents and the strategy draft read them; the strategy&apos;s own text stays its owner&apos;s.
        </InfoTip>
      }
    >
      {data.updated_at && (
        <p className="border-b border-line px-4 py-2 text-sm text-text2 max-[600px]:px-3">
          Last changed {day(data.updated_at, zone)}
          {data.updated_by_name ? ` by ${data.updated_by_name}` : ""}
        </p>
      )}
      {/* qa4-company-37: two columns that grow on their own, so a card being edited grows its
          column only and leaves no tall empty neighbour. On a narrow screen the columns give way
          (display: contents) and the cards stand in their own order, one under another. */}
      <div data-testid="positioning-grid" className="grid grid-cols-2 gap-px bg-line max-[900px]:flex max-[900px]:flex-col">
        {[0, 1].map((col) => (
          <div key={col} className="flex flex-col divide-line bg-surface min-[901px]:divide-y max-[900px]:contents">
            {FIELDS.map((f, i) =>
              i % 2 === col ? (
                <Field
                  key={f.key}
                  order={i}
                  field={f}
                  data={data}
                  suggestions={data.suggestions.filter((s) => s.field === f.key)}
                  canEdit={can("update_positioning")}
                  canDecide={can("accept_positioning_suggestion")}
                  onChanged={set}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Field({
  order,
  field,
  data,
  suggestions,
  canEdit,
  canDecide,
  onChanged,
}: {
  /** Its place among the six, the order it stands in on a narrow screen. */
  order: number;
  field: (typeof FIELDS)[number];
  data: PositioningOut;
  suggestions: Suggestion[];
  canEdit: boolean;
  canDecide: boolean;
  onChanged: (out: PositioningOut) => void;
}) {
  const items = data.fields[field.key] ?? [];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = field.key === "market_category";

  async function save() {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const limit = single ? 1 : 10;
    if (lines.length > limit) return setError(single ? "The market category is one item" : "At most 10 items");
    if (lines.some((l) => l.length > 300)) return setError("An item is at most 300 characters");
    // An unchanged line keeps its item (and its id); a new line is a new item.
    const kept = new Map(items.map((i) => [i.text, i.id]));
    const next = lines.map((l) => ({ id: kept.get(l) ?? null, text: l }));
    const fields = Object.fromEntries(Object.entries(data.fields).map(([k, v]) => [k, v.map((i) => ({ id: i.id, text: i.text }))]));
    await run(async () => {
      const out = await unwrap(api.PUT("/v1/positioning", { body: { fields: { ...fields, [field.key]: next }, lock_version: data.lock_version } }));
      setEditing(false);
      onChanged(out);
    });
  }

  async function run(call: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const decide = (s: Suggestion, act: "accept" | "dismiss") =>
    run(async () => {
      const path = { params: { path: { suggestion_id: s.id } } };
      const out =
        act === "accept"
          ? await unwrap(api.POST("/v1/positioning-suggestions/{suggestion_id}/accept", path))
          : await unwrap(api.POST("/v1/positioning-suggestions/{suggestion_id}/dismiss", path));
      onChanged(out);
    });

  return (
    <section
      data-testid="positioning-field"
      data-field={field.key}
      style={{ order }}
      className="flex min-w-0 flex-col gap-2 bg-surface px-4 py-3 [overflow-wrap:anywhere] max-[600px]:px-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="font-display text-[17px] font-bold">{field.title}</h3>
        <span className="flex-1" />
        {canEdit && !editing && (
          <Button
            variant="ghost"
            onClick={() => {
              setText(items.map((i) => i.text).join("\n"));
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      <p className="text-sm text-text2">{field.hint}</p>
      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-text2">
            {single ? field.title : `${field.title}, one per line`}
            <textarea className={`${INPUT} min-h-24`} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {field.key === "alternatives" && <ListedAlternatives text={text} onAdd={setText} />}
          <div className="flex gap-2">
            <Button variant="solid" disabled={busy} onClick={save}>
              Save
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-text2">Not written yet</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[15px]">
          {items.map((i) => (
            <li key={i.id} data-testid="positioning-item">
              {i.text}
            </li>
          ))}
        </ul>
      )}
      {suggestions.map((s) => (
        <div key={s.id} data-testid="positioning-suggestion" className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface2 px-3 py-2">
          <p className="text-[15px]">
            <span className="font-semibold">Oracle suggests · {ACTION_LABEL[s.action]}</span>
            {suggestionText(s, items)}
          </p>
          <p className="text-sm text-text2">{s.rationale}</p>
          {s.refs.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 text-sm" aria-label="Evidence">
              {s.refs.map((r) => (
                <li key={`${r.kind}-${r.id}`} data-testid="suggestion-ref" className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Link href={refHref(r)} className="text-accent-ink hover:underline">
                    {REF_LABEL[r.kind]}
                    {r.title ? `: ${r.title}` : ""}
                  </Link>
                  {r.kind === "web" && r.vetted === false && <Chip kind="warn">Not vetted</Chip>}
                </li>
              ))}
            </ul>
          )}
          {canDecide && (
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => decide(s, "accept")}>
                Accept
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => decide(s, "dismiss")}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      ))}
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

/**
 * qa4-company-37: editing Competitive alternatives offers the alternatives listed on the
 * Alternatives tab that are not lines yet, to start from; Add them puts them in as lines.
 */
function ListedAlternatives({ text, onAdd }: { text: string; onAdd: (text: string) => void }) {
  const list = useQuery("competitors", () => unwrap(api.GET("/v1/competitors")));
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const have = new Set(lines.map((l) => l.toLowerCase()));
  const missing = (list.data ?? []).map((c) => c.name).filter((n) => !have.has(n.toLowerCase()));
  if (missing.length === 0) return null;
  return (
    <div data-testid="listed-alternatives" className="flex flex-wrap items-center gap-2 text-sm text-text2">
      <span className="min-w-0">Listed on Alternatives: {missing.join(", ")}</span>
      <Button variant="ghost" icon="plus" onClick={() => onAdd([...lines, ...missing].join("\n"))}>
        Add them
      </Button>
    </div>
  );
}

/** What a suggestion says after its action: a Remove or Replace names the item it acts on. */
function suggestionText(s: Suggestion, items: { id: string; text: string }[]): string {
  const target = s.action === "add" ? undefined : items.find((i) => i.id === s.item_id);
  const named = target ? target.text : s.item_id ? "an item no longer in this field" : "";
  if (s.action === "remove") return named ? `: ${named}` : "";
  if (s.action === "replace") return `${named ? ` ${named}` : ""}${s.text ? ` with: ${s.text}` : ""}`;
  return s.text ? `: ${s.text}` : "";
}

/** Where a suggestion's evidence opens in Oracle. */
function refHref(r: Suggestion["refs"][number]): string {
  if (r.kind === "change") return `/company/market?tab=changes&change=${r.id}`;
  if (r.kind === "web") return "/company/market?tab=changes&view=web";
  if (r.kind === "request") return `/requests?request=${r.id}`;
  return `/sources?item=${r.id}`;
}

