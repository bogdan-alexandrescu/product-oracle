"use client";

import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SIMPLE_MODE } from "../_flag";
import { SimpleRoadmap } from "./_roadmap";
import { FitRoadmap, useFit } from "@/components/simple/FitDate"; // MOCK-HOOK

// MOCK-HOOK: mk-fitdate shows its own goal and milestones when ?fd1=a (or fd2/fd3 alone) is set.
function Roadmap() { // MOCK-HOOK
  const fit = useFit(); // MOCK-HOOK
  if (!fit.on || fit.fd1 !== "a") return <SimpleRoadmap />; // MOCK-HOOK
  return ( // MOCK-HOOK
    <div className="simple-mode space-y-3 px-4 py-4 max-[600px]:pb-[calc(var(--phone-tab-bar)+16px)] min-[641px]:px-6" data-testid="simple-roadmap"> {/* MOCK-HOOK */}
      <header className="flex flex-wrap items-center gap-3"> {/* MOCK-HOOK */}
        <h1 className="text-2xl font-semibold max-[600px]:sr-only">Roadmap</h1> {/* MOCK-HOOK */}
        <span className="rounded-2xl bg-accent-soft px-3 py-0.5 text-[15px] font-semibold text-accent-ink">Reply faster in the shared inbox</span> {/* MOCK-HOOK */}
      </header> {/* MOCK-HOOK */}
      <FitRoadmap /> {/* MOCK-HOOK */}
    </div> // MOCK-HOOK
  ); // MOCK-HOOK
} // MOCK-HOOK

/** Simple S4 (#723): the company-wide roadmap (direction "A · Wall"). */
export default function SimpleRoadmapPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <Roadmap /> {/* MOCK-HOOK */}
    </Suspense>
  );
}
