"use client";

import { useState } from "react";

import { INPUT } from "@/app/settings/_components/fields";
import { Avatar, Button, Chip, DataTable, Panel, type Column } from "@/components/ds";
import { LoadError } from "@/components/ui";
import { api, unwrap, type Schemas } from "@/lib/api/client";
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

/** qa-settings-8: a search that finds nobody says so, with the way back (owner table and this list). */
export function NoMatch({ find, onClear }: { find: string; onClear: () => void }) {
  return (
    <span data-testid="people-no-match" className="inline-flex flex-wrap items-center justify-center gap-2 break-words">
      <span>Nobody matches “{find.trim()}”</span>
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
  const rows = peopleQ.data?.filter((p) => matches(q, p.name, p.email));
  const columns: Column<Person>[] = [
    {
      key: "member",
      header: "Member",
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={p.name || p.email} size={28} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-semibold">{p.name}</span>
            {p.name !== p.email && (
              // pass-f F-52: the whole address, as on the owner's table, breaking only after its @.
              <span data-testid="person-email" title={p.email} className="block max-w-full text-[13px] break-words text-text2">
                {p.email.slice(0, p.email.indexOf("@") + 1)}
                <wbr />
                {p.email.slice(p.email.indexOf("@") + 1)}
              </span>
            )}
          </span>
        </span>
      ),
    },
    { key: "role", header: "Role", width: "128px", cell: (p) => <Chip kind="acc">{ROLE_WORD[p.role]}</Chip> },
  ];
  return (
    <div data-testid="people-readonly" className="flex flex-col gap-3">
      <Panel title="People" count={peopleQ.data?.length} tools={<FindPerson value={q} onChange={setQ} />}>
        {peopleQ.error ? (
          <div className="p-4">
            <LoadError what="the people" error={peopleQ.error} onRetry={() => void peopleQ.reload()} />
          </div>
        ) : (
          <DataTable
            label="People"
            columns={columns}
            rows={rows}
            loading={!peopleQ.data}
            rowKey={(p) => p.user_id}
            rowProps={() => ({ "data-testid": "person-row" })}
            empty={q.trim() ? <NoMatch find={q} onClear={() => setQ("")} /> : "No members"}
          />
        )}
      </Panel>
    </div>
  );
}
