"use client";

import { useState } from "react";

import { INPUT } from "@/app/settings/_components/fields";
import { Avatar, Button, Chip, DataTable, Notice, Panel, type Column } from "@/components/ds";
import { api, unwrap, type Schemas } from "@/lib/api/client";
import { displayName } from "@/lib/names";
import { useQuery } from "@/lib/use-query";

type Person = Schemas["PersonOut"];
const ROLE_WORD = { owner: "Owner", approver: "Approver", commenter: "Commenter", viewer: "Viewer" } as const;
/** The API's maximum: everyone in one call (A5). */
const PEOPLE_LIMIT = 500;

/** "Find a person": by name or email, as typed. */
export function matches(needle: string, ...fields: (string | null | undefined)[]) {
  const n = needle.trim().toLowerCase();
  return !n || fields.some((f) => f?.toLowerCase().includes(n));
}

export function FindPerson({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="search"
      aria-label="Find a person"
      placeholder="Find a person"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${INPUT} w-56 max-w-full max-[600px]:w-40`}
    />
  );
}

/** "No one matches "zzz"", with Clear search: a people table when the search finds nobody. */
export function NoMatch({ find, onClear }: { find: string; onClear: () => void }) {
  if (!find.trim()) return <>No members</>;
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-2" data-testid="people-no-match">
      <span>No one matches &ldquo;{find.trim()}&rdquo;</span>
      <Button variant="ghost" onClick={onClear}>
        Clear search
      </Button>
    </span>
  );
}

/**
 * Settings › Members for a non-owner (A5, 3.10): the active members with their names and
 * role chips, read-only, from GET /v1/people. No status, sign-in, tokens or actions.
 */
export function PeopleReadOnly() {
  const peopleQ = useQuery("people:all", () => unwrap(api.GET("/v1/people", { params: { query: { limit: PEOPLE_LIMIT } } })));
  const [q, setQ] = useState("");
  const rows = peopleQ.data?.filter((p) => matches(q, displayName(p.email, p.name), p.email));
  const columns: Column<Person>[] = [
    {
      key: "member",
      header: "Member",
      wrap: true,
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={displayName(p.email, p.name)} size={28} />
          {/* The one name rule (lib/names): their name, or one made from the email; the email under it. */}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="font-semibold [overflow-wrap:anywhere]">{displayName(p.email, p.name)}</span>
            <span className="text-[13px] text-text2 [overflow-wrap:anywhere]">{p.email}</span>
          </span>
        </span>
      ),
    },
    { key: "role", header: "Role", width: "128px", cell: (p) => <Chip kind="acc">{ROLE_WORD[p.role]}</Chip> },
  ];
  return (
    <div data-testid="people-readonly" className="flex flex-col gap-3">
      <Panel title="People" count={rows?.length} tools={<FindPerson value={q} onChange={setQ} />}>
        {peopleQ.error ? (
          <div className="p-4">
            <Notice tone="error">{peopleQ.error}</Notice>
          </div>
        ) : (
          <DataTable
            label="People"
            columns={columns}
            rows={rows}
            loading={!peopleQ.data}
            rowKey={(p) => p.user_id}
            rowProps={() => ({ "data-testid": "person-row" })}
            empty={<NoMatch find={q} onClear={() => setQ("")} />}
          />
        )}
      </Panel>
    </div>
  );
}
