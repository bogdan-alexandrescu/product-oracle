"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { loadLanding } from "@/lib/experience";

/**
 * The bare site URL opens the person's home (UI test finding E1): Studio's Home, or Simple's
 * when they chose Simple or their role lands there (#723, D13).
 */
export default function Root() {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    void loadLanding().then((to) => alive && router.replace(to));
    return () => {
      alive = false;
    };
  }, [router]);
  return null;
}
