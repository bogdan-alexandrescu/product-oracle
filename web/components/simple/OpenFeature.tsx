"use client";
// one-feature-panel: a page that can open the feature panel (the roadmap's FeaturePanel)
// gives its opener here; a feature named inside it (the one-pager's plan rows and milestone
// parts) becomes a button that opens it. With no opener the name stays plain text.

import { createContext, useContext } from "react";

/** What opens the panel: a roadmap item's id when known, else its code, PRD and name. */
export type OpenFeature = (f: { id?: string | null; code: string; name: string; prd?: { id: string; slug: string } | null }) => void;

export const OpenFeatureContext = createContext<OpenFeature | null>(null);

export const useOpenFeature = () => useContext(OpenFeatureContext);
