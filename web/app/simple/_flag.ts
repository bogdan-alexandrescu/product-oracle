/**
 * Simple (#723) is behind ORACLE_SIMPLE_MODE, off by default: Detailed is unchanged while
 * it is off. next.config.ts inlines the variable at build time; the mock build turns it on
 * so the mock-backed specs drive Simple's screens.
 */
export const SIMPLE_MODE = process.env.ORACLE_SIMPLE_MODE === "1" || process.env.ORACLE_SIMPLE_MODE === "on";
