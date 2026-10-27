/**
 * Simple (#723) is behind ORACLE_SIMPLE_MODE, off by default: Detailed is unchanged while it
 * is off. One flag for every Simple page: @/lib/simple-mode (NEXT_PUBLIC_ORACLE_SIMPLE_MODE,
 * on in the mock build). This module used to read ORACLE_SIMPLE_MODE, which the production
 * web build does not set, so the roadmap alone answered 404.
 */
export { SIMPLE_MODE } from "@/lib/simple-mode";
