"use client";

import { notFound } from "next/navigation";

import { SIMPLE_MODE } from "../_flag";
import { SimpleRoadmap } from "./_roadmap";

/** Simple S4 (#723): the company-wide roadmap (direction "A · Wall"). */
export default function SimpleRoadmapPage() {
  if (!SIMPLE_MODE) notFound();
  return <SimpleRoadmap />;
}
