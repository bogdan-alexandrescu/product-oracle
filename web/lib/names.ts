/**
 * The one name rule for people (api/oracle/members/names.py): a member's own name when set
 * (A5); without one, "first.last@example.com" reads "First Last". The mock API names people
 * with it as the API does; screens read names from GET /v1/people.
 */
export function displayName(email: string, name?: string | null): string {
  if (name?.trim()) return name.trim();
  const words = email.split("@")[0].split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
