import { displayName } from "@/lib/names";

import { MOCK_MEMBERS } from "./fixtures";

/**
 * The one name rule as the mock API applies it (qa5-mock-people): a member's stored name when
 * the caller passes it, and an empty one reads by the email as the API does; a caller that
 * knows only the email gets the seeded member's invented name, else the one the email reads.
 */
export function mockName(email: string, name?: string | null): string {
  return displayName(email, name !== undefined ? name : MOCK_MEMBERS.find((m) => m.email === email)?.name);
}
