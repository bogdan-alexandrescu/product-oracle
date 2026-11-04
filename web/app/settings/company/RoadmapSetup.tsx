"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Notice, Panel } from "@/components/ds";
import { api, ApiError, unwrap, type Schemas } from "@/lib/api/client";
import { useMe } from "@/lib/me";
import { errorMessage, useQuery } from "@/lib/use-query";

import { INPUT } from "../_components/fields";

const ROW = "grid grid-cols-[160px_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 max-[600px]:grid-cols-1 max-[600px]:gap-1.5 max-[600px]:px-3";
const ROW_LABEL = "text-[15px] font-semibold";
const SMALL = INPUT.replace("w-full", "w-24");

/** null while the company has none (the API's 404). */
const readCompanyRoadmap = () =>
  unwrap(api.GET("/v1/roadmaps/company")).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });

/**
 * one-roadmap-many-prds: the company's one roadmap (Product roadmap), which every PRD feeds.
 * The first-run step: an approver or owner creates it; once made, it links to it.
 */
export function ProductRoadmapPanel() {
  const { can } = useMe();
  const q = useQuery("company-roadmap", readCompanyRoadmap);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const made = await unwrap(api.POST("/v1/roadmaps/company"));
      q.setData(() => made);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const found = q.data;
  return (
    <div id="product-roadmap" className="scroll-mt-4" data-testid="product-roadmap-panel">
      <Panel title="Product roadmap">
        <div className="flex flex-col gap-3 px-4 py-3 max-[600px]:px-3">
          {q.error && <Notice tone="error">{q.error}</Notice>}
          {found && (
            <p className="text-[15px]" data-testid="product-roadmap-state">
              Created:{" "}
              <Link href={`/documents/${found.slug}`} className="font-semibold text-accent-ink hover:underline">
                {found.title}
              </Link>
              . Every PRD&apos;s items go on it.
            </p>
          )}
          {found === null && (
            <>
              <p className="text-[15px]" data-testid="product-roadmap-state">
                No product roadmap yet. The company has one roadmap, and every PRD&apos;s items go on it.
              </p>
              {can("create_company_roadmap") ? (
                <div>
                  <Button variant="solid" disabled={busy} onClick={() => void create()}>
                    Create the product roadmap
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-text2">An approver or owner creates it.</p>
              )}
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </Panel>
    </div>
  );
}

type Capacity = { team_size: number; focus: number };

/**
 * one-roadmap-many-prds: the one team that plans every PRD's items: its size and the share of
 * its time it gives the roadmap (focus). Owners change it.
 */
export function TeamCapacityPanel({ canChange }: { canChange: boolean }) {
  const settingQ = useQuery("settings|team_capacity", () => unwrap(api.GET("/v1/settings/{key}", { params: { path: { key: "team_capacity" } } })));
  const stored = settingQ.data ? (settingQ.data.value as Capacity) : null;
  const [size, setSize] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sizeText = size ?? (stored ? String(stored.team_size) : "");
  const focusText = focus ?? (stored ? String(Math.round(stored.focus * 100)) : "");
  const changed = !!stored && (sizeText !== String(stored.team_size) || focusText !== String(Math.round(stored.focus * 100)));

  function wrong(): string | null {
    const n = Number(sizeText);
    if (!sizeText.trim() || !Number.isInteger(n) || n < 1 || n > 1000) return "Team size is a whole number from 1 to 1000.";
    const f = Number(focusText);
    if (!focusText.trim() || !Number.isFinite(f) || f <= 0 || f > 100) return "Focus is more than 0% and at most 100%.";
    return null;
  }

  async function save() {
    const problem = wrong();
    setError(problem);
    if (problem) return;
    setBusy(true);
    setSaved(false);
    try {
      const value = { team_size: Number(sizeText), focus: Number(focusText) / 100 };
      const out: Schemas["SettingOut"] = await unwrap(api.PUT("/v1/settings/{key}", { params: { path: { key: "team_capacity" } }, body: { value } }));
      settingQ.setData(() => out);
      setSize(null);
      setFocus(null);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setSaved(false);
    setError(null);
  };
  return (
    <div id="team-capacity" className="scroll-mt-4" data-testid="team-capacity-panel">
      <Panel title="Team capacity">
        {settingQ.error && (
          <div className="p-4">
            <Notice tone="error">{settingQ.error}</Notice>
          </div>
        )}
        {stored && (
          <form
            // Our own words for a wrong value, not the browser's.
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p className="px-4 pt-3 text-sm text-text2 max-[600px]:px-3">One team builds every PRD&apos;s items, in order. Dates on the roadmap follow its size and focus.</p>
            <div className={ROW}>
              <label htmlFor="team-size" className={ROW_LABEL}>
                Team size
              </label>
              <div className="flex items-center gap-2 text-[15px]">
                <input id="team-size" type="number" inputMode="numeric" min={1} max={1000} step={1} className={SMALL} value={sizeText} disabled={!canChange} onChange={edit(setSize)} />
                <span className="text-text2">people</span>
              </div>
            </div>
            <div className={`${ROW} border-t border-line`}>
              <label htmlFor="team-focus" className={ROW_LABEL}>
                Focus
              </label>
              <div className="flex items-center gap-2 text-[15px]">
                <input id="team-focus" type="number" inputMode="numeric" min={1} max={100} className={SMALL} value={focusText} disabled={!canChange} onChange={edit(setFocus)} />
                <span className="text-text2">% of their time on the roadmap</span>
              </div>
            </div>
            {error && (
              <div className="px-4 pb-1 max-[600px]:px-3">
                <Notice tone="error">{error}</Notice>
              </div>
            )}
            {canChange && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-[600px]:px-3">
                <Button type="submit" variant="solid" disabled={busy || !changed}>
                  Save
                </Button>
                {!saved && !changed && (
                  <span data-testid="team-capacity-save-reason" className="text-sm text-text2">
                    Change the size or focus to save it.
                  </span>
                )}
                {saved && (
                  <span role="status" className="text-sm font-semibold text-pass" data-testid="team-capacity-saved">
                    Saved
                  </span>
                )}
              </div>
            )}
          </form>
        )}
      </Panel>
    </div>
  );
}
