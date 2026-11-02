"use client";
// MOCK-HOOK: the whole file. Option c of "Starting a PRD from Simple": the New PRD page a goal card opens.

import { NewPrdPage, useNp } from "@/components/simple/NewPrdMock";

export default function NewPrd() {
  const np = useNp(); // MOCK-HOOK
  return <NewPrdPage np={np} />; // MOCK-HOOK
}
