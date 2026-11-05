"use client";

// New PRD's optional "Replaces" field (new-prd-from-replaced-prd, owner Nov 4): pick one
// approved PRD this one replaces, name the area of it this PRD covers and tick its items in
// that area. Before Start the sheet shows what the draft carries from it: its standing
// decisions and its verified estimates and commitments for those items, so they are not
// argued again.

import { Icon } from "@/components/ds/Icon";
import { dmy } from "@/components/simple/PrdTimeline";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery } from "@/lib/use-query";

type Carried = Schemas["Carried"];

export interface Replaces {
  documentId: string;
  areaName: string;
  areaScope: string;
  itemKeys: string[];
}

export const NO_REPLACES: Replaces = { documentId: "", areaName: "", areaScope: "", itemKeys: [] };

/** Whether the field is left empty or filled enough to send. */
export function replacesReady(r: Replaces): boolean {
  return !r.documentId || (r.areaName.trim().length > 0 && r.areaScope.trim().length > 0);
}

/** The brief's ``replaces``, or null when none is picked. */
export function replacesBody(r: Replaces): Schemas["ReplacesIn"] | null {
  if (!r.documentId) return null;
  return { document_id: r.documentId, area_name: r.areaName.trim(), area_scope: r.areaScope.trim(), item_keys: r.itemKeys };
}

const KIND: Record<string, string> = { estimate: "Estimate", capacity: "Capacity", commitment: "Commitment" };

/** What the draft carries from the PRD it replaces: its decisions and estimates. */
export function CarriedList({ carried }: { carried: Carried }) {
  const titles = new Map(carried.items.map((i) => [i.key, i.title]));
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface2 p-3" data-testid="np-carried">
      <p className="text-[15px] font-semibold text-text">Carried from {carried.title}</p>
      <p className="simple-small">The draft keeps these and does not argue them again.</p>
      <div className="flex flex-col gap-1">
        <span className="simple-small font-semibold">Decisions</span>
        {carried.decisions.length === 0 ? (
          <span className="simple-small">No standing decisions about it.</span>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="np-carried-decisions">
            {carried.decisions.map((d) => (
              <li key={d.id} className="flex items-start gap-1.5 text-[15px] text-text">
                <Icon name="check" size={16} />
                <span>
                  D-{d.number} {d.title}
                </span>
              </li>
            ))}
          </ul>
        )}
        {carried.left_out.length > 0 && <span className="simple-small" data-testid="np-carried-left-out">Left out, no longer standing: {carried.left_out.join("; ")}</span>}
      </div>
      <div className="flex flex-col gap-1">
        <span className="simple-small font-semibold">Verified estimates and commitments</span>
        {carried.bases.length === 0 ? (
          <span className="simple-small">{carried.items.some((i) => i.in_area) ? "None for the items in this area." : "Pick its items in this area to carry their estimates."}</span>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="np-carried-estimates">
            {carried.bases.map((b) => (
              <li key={b.id} className="text-[15px] text-text">
                {KIND[b.kind] ?? b.kind} {b.reference} for {titles.get(b.item_key) ?? b.item_key}: {dmy(b.supports_date)}
                {b.detail ? <span className="simple-small"> · {b.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ReplacesField({ value, onChange, field, label }: { value: Replaces; onChange: (r: Replaces) => void; field: string; label: string }) {
  const prds = useQuery("documents|prd", () => unwrap(api.GET("/v1/documents", { params: { query: { kind: "prd" } } })));
  const approved = (prds.data ?? []).filter((d) => d.approved_version != null);
  const id = value.documentId;
  const keys = value.itemKeys;
  const carried = useQuery(
    `carried|${id}|${keys.join(",")}`,
    () => (id ? unwrap(api.GET("/v1/intakes/replaces/{document_id}/carried", { params: { path: { document_id: id }, query: { item_keys: keys } } })) : Promise.resolve(null)),
    { keepPrevious: true },
  );
  const data = id && carried.data?.document_id === id ? carried.data : null;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="np-replaces">
      <legend className={`${label} mb-1.5`}>
        Replaces <span className="simple-small font-normal">(optional)</span>
      </legend>
      <select
        aria-label="Approved PRD it replaces"
        className={field}
        value={id}
        onChange={(e) => onChange({ ...NO_REPLACES, documentId: e.target.value })}
      >
        <option value="">None: a new PRD</option>
        {approved.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </select>
      {id && (
        <>
          <p className="simple-small">Name the part of it this PRD covers. Its decisions and verified estimates for that part come with it.</p>
          <label className="flex flex-col gap-1.5">
            <span className="simple-small font-semibold">Area</span>
            <input className={field} placeholder="For example: User Safety" value={value.areaName} maxLength={60} onChange={(e) => onChange({ ...value, areaName: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="simple-small font-semibold">What the area covers, in one line</span>
            <input className={field} placeholder="For example: caps, tripwires and ban prevention" value={value.areaScope} maxLength={200} onChange={(e) => onChange({ ...value, areaScope: e.target.value })} />
          </label>
          {data && data.items.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="simple-small font-semibold">Its items in this area</span>
              <div className="flex flex-wrap gap-2">
                {data.items.map((i) => {
                  const on = keys.includes(i.key);
                  return (
                    <button
                      key={i.key}
                      type="button"
                      aria-pressed={on}
                      className={`simple-chip ${on ? "border-accent! bg-accent! font-semibold text-on-accent!" : ""}`}
                      onClick={() => onChange({ ...value, itemKeys: on ? keys.filter((k) => k !== i.key) : [...keys, i.key] })}
                    >
                      {on && <Icon name="check" size={16} />}
                      {i.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {carried.error && (
            <p role="alert" className="simple-small">
              {carried.error}
            </p>
          )}
          {data && <CarriedList carried={data} />}
        </>
      )}
    </fieldset>
  );
}
