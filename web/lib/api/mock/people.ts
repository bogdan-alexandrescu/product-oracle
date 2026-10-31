import { displayName } from "@/lib/names";

import { MOCK_MEMBERS } from "./fixtures";

/**
 * The one name rule as the mock API applies it (qa5-mock-people): a member's own name when
 * given, else a seeded member's invented name, else the one the email reads.
 */
export function mockName(email: string, name?: string | null): string {
  return displayName(email, name?.trim() ? name : MOCK_MEMBERS.find((m) => m.email === email)?.name);
}
