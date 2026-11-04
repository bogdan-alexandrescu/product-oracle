"use client";

import { notFound } from "next/navigation";
import { Suspense } from "react";

import { WithFeatureMarks } from "@/components/current-state/CurrentState";

import { SIMPLE_MODE } from "../_flag";
import { SimpleRoadmap } from "./_roadmap";

/** Simple S4 (#723): the company-wide roadmap (direction "A · Wall"). */
export default function SimpleRoadmapPage() {
  if (!SIMPLE_MODE) notFound();
  return (
    <Suspense>
      <WithFeatureMarks>
        <SimpleRoadmap />
      </WithFeatureMarks>
    </Suspense>
  );
}
