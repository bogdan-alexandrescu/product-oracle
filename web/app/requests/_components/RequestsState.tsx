"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { api, unwrap, type Schemas } from "@/lib/api/client";
import { useQuery, type Query } from "@/lib/use-query";

/** The queue's filters (All requests, To decide). */
export type RequestFilters = { state: string; goal: string; theme: string; search: string; toSend: boolean };

export const NO_FILTERS: RequestFilters = { state: "", goal: "", theme: "", search: "", toSend: false };

/** The request picked by hand, and the ?request= it was picked under (a new ?request= wins). */
type Picked = { id: string; under: string | null };

type Shared = {
  filters: RequestFilters;
  setFilters: (change: Partial<RequestFilters>) => void;
  /** C1 lane 2: the qualified requests ticked for Start a PRD. */
  chosen: string[];
  setChosen: (ids: string[]) => void;
  picked: Picked | null;
  setPicked: (picked: Picked | null) => void;
  /** Every theme, archived too: the Themes tab, its count on the tab and the Theme filter. */
  themes: Query<Schemas["RequestThemeOut"][]>;
};

const RequestsStateContext = createContext<Shared | null>(null);

/**
 * What the Requests tabs share, held by their layout: the filters, the ticked requests, the
 * selection and the themes stay as they were when a person moves between All requests, To
 * decide and Themes, and the Themes tab shows its count on every tab.
 */
export function RequestsStateProvider({ children }: { children: ReactNode }) {
  const [filters, setAll] = useState<RequestFilters>(NO_FILTERS);
  const [chosen, setChosen] = useState<string[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const themes = useQuery("request-themes", () => unwrap(api.GET("/v1/request-themes", { params: { query: { include_archived: true } } })));
  const setFilters = (change: Partial<RequestFilters>) => setAll((f) => ({ ...f, ...change }));
  return (
    <RequestsStateContext.Provider value={{ filters, setFilters, chosen, setChosen, picked, setPicked, themes }}>
      {children}
    </RequestsStateContext.Provider>
  );
}

export function useRequestsState(): Shared {
  const shared = useContext(RequestsStateContext);
  if (!shared) throw new Error("useRequestsState is used outside the Requests layout");
  return shared;
}
