"use client";

import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SIMPLE_MODE } from "../_flag";
import { LadderSwitch } from "./_ladder"; // MOCK-HOOK
import { GoalMapPage } from "./_map";

/** Simple › Goal map (build-goal-map): goals, the guardrail and areas by milestone ("Ladder by area lanes"). */
export default function SimpleGoalMapPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <LadderSwitch where="map"> {/* MOCK-HOOK */}
        <GoalMapPage />
      </LadderSwitch> {/* MOCK-HOOK */}
    </Suspense>
  );
}
