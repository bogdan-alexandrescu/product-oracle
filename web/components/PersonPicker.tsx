"use client";

import { useEffect, useId, useState } from "react";

import { InlineError, TEXTAREA } from "@/components/review/parts";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { errorMessage } from "@/lib/use-query";

export type Person = Schemas["PersonOut"];

/** The member directory (GET /v1/people), matched on email; `q` empty lists the first page. */
export function findPeople(q: string): Promise<Person[]> {
  return unwrap(api.GET("/v1/people", { params: { query: { q: q.trim() || undefined, limit: 20 } } }));
}

/** The named people (GET /v1/people?ids=), by id, however many the company has: who a
 * question waits on or who answered it. */
export async function peopleByIds(ids: readonly (string | null | undefined)[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const people = await unwrap(api.GET("/v1/people", { params: { query: { ids: unique } } }));
  return new Map(people.map((p) => [p.user_id, p]));
}

/**
 * The member picker every non-owner uses (C2): a search box over GET /v1/people and the
 * people it finds, by name and email. `writersOnly` lists only those who can answer or
 * comment (commenter and above); `approversOnly` only those who can approve (approver and
 * owner); `exclude` leaves out ids (the person already asked).
 */
export function PersonPicker({
  onPick,
  writersOnly = true,
  approversOnly = false,
  exclude = [],
  autoFocus = false,
}: {
  onPick: (person: Person) => void;
  writersOnly?: boolean;
  approversOnly?: boolean;
  exclude?: readonly string[];
  autoFocus?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    findPeople(q)
      .then((rows) => {
        if (!live) return;
        setPeople(rows);
        setError(null);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [q]);

  const shown = (people ?? []).filter((p) => (!writersOnly || p.can_write) && (!approversOnly || p.role === "approver" || p.role === "owner") && !exclude.includes(p.user_id));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="person-picker">
      <input
        type="search"
        aria-label="Find a person"
        aria-controls={`${id}-list`}
        placeholder="Name or email"
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={`${TEXTAREA} h-9`}
      />
      <ul id={`${id}-list`} role="listbox" aria-label="People" className="flex max-h-48 min-w-0 flex-col gap-0.5 overflow-y-auto">
        {shown.map((p) => (
          <li key={p.user_id} className="min-w-0">
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onPick(p)}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-surface2"
            >
              <span className="flex-none font-semibold text-text">{p.name}</span>
              <span className="min-w-0 truncate text-text2">{p.email}</span>
            </button>
          </li>
        ))}
        {people && shown.length === 0 && <li className="px-2 py-1.5 text-sm text-text2">Nobody found</li>}
      </ul>
      {error && <InlineError>{error}</InlineError>}
    </div>
  );
}
