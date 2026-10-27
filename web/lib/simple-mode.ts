import { MOCK_MODE } from "@/lib/api/client";

/**
 * Simple mode (#723) is behind ORACLE_SIMPLE_MODE, off by default (exposed to the web as
 * NEXT_PUBLIC_ORACLE_SIMPLE_MODE, inlined at build time); the mock build turns it on so its
 * specs drive Simple's screens. Off, Simple's pages are not found and Detailed is unchanged.
 */
export const SIMPLE_MODE = process.env.NEXT_PUBLIC_ORACLE_SIMPLE_MODE === "1" || MOCK_MODE;
