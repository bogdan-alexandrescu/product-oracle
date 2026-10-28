"use client";

import { useState, useSyncExternalStore } from "react";

import { Notice, Page, PageHeader, SegmentedControl } from "@/components/ds";
import { useMe } from "@/lib/me";
import { useTheme } from "@/lib/theme";

import { Gallery } from "./_gallery";

type Mode = "light" | "dark" | "both";

/** A developer page (qa-settings-9): it says so, and it stays out of every navigation. */
const TITLE = "Design system (developers)";
const DEVELOPER_NOTE = "Developer page: the components the app is built from. Not part of the product.";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function useSystemDark(): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = window.matchMedia(DARK_QUERY);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    },
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

/**
 * The kit page: every part of components/ds in each state (owners only, not in the
 * navigation). Light and Dark switch the app's theme; Both draws the gallery twice,
 * the second copy scoped to the other theme by `.ds-light` / `.ds-dark`.
 */
export default function DesignPage() {
  const { can, capsReady } = useMe();
  const [theme, setTheme] = useTheme();
  const systemDark = useSystemDark();
  const [both, setBoth] = useState(false);
  // #370: the kit is for whoever may read the company's settings (owners).
  const owner = can("get_setting_endpoint");

  if (!capsReady || !owner) {
    return (
      <Page>
        <PageHeader title={TITLE} testId="design-header" />
      </Page>
    );
  }

  const resolved: Exclude<Mode, "both"> = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const mode: Mode = both ? "both" : resolved;
  const choose = (m: Mode) => {
    if (m === "both") return setBoth(true);
    setBoth(false);
    setTheme(m);
  };

  return (
    <Page>
      <PageHeader
        title={TITLE}
        testId="design-header"
        action={
          <SegmentedControl
            label="Theme"
            value={mode}
            onChange={choose}
            items={[
              { value: "light", label: "Light", testId: "design-mode-light" },
              { value: "dark", label: "Dark", testId: "design-mode-dark" },
              { value: "both", label: "Both", testId: "design-mode-both" },
            ]}
          />
        }
      />
      <Notice testId="design-developer-note">{DEVELOPER_NOTE}</Notice>
      {both ? (
        <div className="grid grid-cols-2 items-start gap-4 max-[1100px]:grid-cols-1" data-testid="design-both">
          <div className="ds-light min-w-0 rounded-panel bg-bg p-3 text-text" data-theme-preview="light">
            <Gallery />
          </div>
          <div className="ds-dark min-w-0 rounded-panel bg-bg p-3 text-text" data-theme-preview="dark">
            <Gallery tid="design-dark" />
          </div>
        </div>
      ) : (
        <Gallery />
      )}
    </Page>
  );
}
