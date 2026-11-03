"use client";

import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SIMPLE_MODE } from "../_flag";
import { GoalMapPage } from "./_map";

/** MOCK-HOOK (GM1 mock-ups, never merged): Simple › Goal map, its proposals behind ?gm1=a|b|c|d. */
export default function SimpleGoalMapPage() {
  if (!SIMPLE_MODE) notFound(); // MOCK-HOOK
  return (
    <Suspense>
      <GoalMapPage />
    </Suspense>
  );
}
