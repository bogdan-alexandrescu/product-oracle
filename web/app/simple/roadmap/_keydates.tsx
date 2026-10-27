"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ds";

import type { Act } from "./_card";
import { shortDay, type KeyDate, type Roadmap } from "./_lib";

type Draft = { name: string; date: string; note: string };
const EMPTY: Draft = { name: "", date: "", note: "" };

const value = (k: KeyDate) => ({ name: k.name, date: k.date, note: k.note ?? null });

/**
 * Roadmap-plus: the roadmap header's small "Key dates" editor (a conference, a product launch,
 * a board meeting). Every edit is a change through the engine (add_key_date, edit_key_date,
 * remove_key_date): owners and the decider apply it into the roadmap's working draft (Undo
 * in the toast), approvers and commenters propose it; viewers read. A sheet on a phone.
 */
export function KeyDatesEditor({ data, act, mayChange, phone, onClose }: { data: Roadmap; act: Act; mayChange: boolean; phone: boolean; onClose: () => void }) {
  const roadmaps = data.key_date_roadmaps ?? [];
  const [rm, setRm] = useState(roadmaps[0]?.roadmap.id ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState<Draft>(EMPTY);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const current = roadmaps.find((r) => r.roadmap.id === rm) ?? roadmaps[0];
  const list = (data.key_dates ?? []).filter((k) => k.roadmap.id === current?.roadmap.id);
  const can = mayChange && !!current?.can_change;

  const add = async () => {
    if (!current || !adding.name.trim() || !adding.date) return;
    await act(`Added the key date '${adding.name.trim()}'`, {
      op: "add_key_date",
      target: { document_id: current.roadmap.id },
      before: { key_date: null },
      after: { name: adding.name, date: adding.date, note: adding.note || null },
    });
    setAdding(EMPTY);
  };
  const save = async (k: KeyDate) => {
    await act(`Changed the key date '${form.name.trim() || k.name}'`, {
      op: "edit_key_date",
      target: { document_id: k.roadmap.id, key_date_id: k.id },
      before: { key_date: value(k) },
      after: { name: form.name, date: form.date, note: form.note || null },
    });
    setEditing(null);
  };
  const remove = async (k: KeyDate) => {
    await act(`Removed the key date '${k.name}'`, {
      op: "remove_key_date",
      target: { document_id: k.roadmap.id, key_date_id: k.id },
      before: { key_date: value(k) },
      after: {},
    });
  };

  const field = "rounded-lg border border-line bg-bg px-2 py-1 text-[15px]";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Key dates"
      data-testid="key-dates-editor"
      data-sheet={phone ? "bottom" : "float"}
      className={`${phone ? "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] rounded-t-2xl" : "absolute top-12 right-0 z-40 w-[440px] rounded-xl"} max-w-[calc(100vw-16px)] overflow-y-auto border border-line bg-surface p-4 shadow-tip outline-none`}
    >
      <div className="flex items-start gap-2">
        <h2 className="flex-1 text-lg font-semibold">Key dates</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="h-7 w-7 flex-none rounded text-text2 hover:bg-surface2">
          ×
        </button>
      </div>
      {roadmaps.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-sm text-text2">
          Roadmap
          <select aria-label="Roadmap" value={current?.roadmap.id ?? ""} onChange={(e) => setRm(e.target.value)} className={field} data-testid="key-dates-roadmap">
            {roadmaps.map((r) => (
              <option key={r.roadmap.id} value={r.roadmap.id}>
                {r.roadmap.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="mt-2 text-sm text-text2" data-testid="key-dates-hint">
        {!can
          ? "Owners and the roadmap's decider change key dates; you read them."
          : current?.applies
            ? "Your changes go into the roadmap's working draft (Undo in the message)."
            : "Owners and the roadmap's decider change key dates; yours are proposals they accept or decline."}
      </p>
      <ul className="mt-3 space-y-2" aria-label="This roadmap's key dates">
        {list.length === 0 && <li className="text-sm text-text2">No key dates yet.</li>}
        {list.map((k) =>
          editing === k.id ? (
            <li key={k.id} className="space-y-2 rounded-lg border border-accent p-2" data-testid="key-date-edit">
              <input aria-label="Name" className={`${field} w-full`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <div className="flex gap-2">
                <input aria-label="Date" type="date" className={field} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                <input aria-label="Note" className={`${field} min-w-0 flex-1`} placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                <Button variant="primary" disabled={!form.name.trim() || !form.date} onClick={() => void save(k)}>
                  {current?.applies ? "Save" : "Propose"}
                </Button>
              </div>
            </li>
          ) : (
            <li key={k.id} className="flex items-start gap-2 rounded-lg border border-line p-2" data-testid="key-date-row" data-name={k.name}>
              <span aria-hidden className="mt-1.5 inline-block h-2.5 w-2.5 flex-none rotate-45 bg-accent-ink" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {k.name} <span className="text-text2">· {shortDay(k.date)}</span>
                  {k.in_draft && (
                    <span className="ml-2 rounded-full bg-surface2 px-2 text-xs text-text2" data-testid="key-date-in-draft">
                      in the draft
                    </span>
                  )}
                </div>
                {k.note && <div className="text-sm text-text2">{k.note}</div>}
              </div>
              {can && (
                <span className="flex flex-none gap-1">
                  <Button
                    aria-label={`Edit ${k.name}`}
                    onClick={() => {
                      setForm({ name: k.name, date: k.date, note: k.note ?? "" });
                      setEditing(k.id);
                    }}
                  >
                    Edit
                  </Button>
                  <Button aria-label={`Remove ${k.name}`} onClick={() => void remove(k)}>
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {can && (
        <form
          className="mt-3 space-y-2 border-t border-line pt-3"
          data-testid="key-date-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h3 className="text-sm font-semibold">Add a key date</h3>
          <input aria-label="New key date's name" className={`${field} w-full`} placeholder="A conference, a launch, a board meeting" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          <div className="flex gap-2">
            <input aria-label="New key date's day" type="date" className={field} value={adding.date} onChange={(e) => setAdding({ ...adding, date: e.target.value })} />
            <input aria-label="New key date's note" className={`${field} min-w-0 flex-1`} placeholder="Note (optional)" value={adding.note} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={!adding.name.trim() || !adding.date}>
              {current?.applies ? "Add" : "Propose"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
