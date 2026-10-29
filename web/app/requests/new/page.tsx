import { redirect } from "next/navigation";

/** rirs-36: the To decide tab moved to /requests/to-decide; an old link (with its ?request=) lands there. */
export default async function OldToDecidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const one of [v].flat()) if (one !== undefined) params.append(k, one);
  const query = params.toString();
  redirect(`/requests/to-decide${query ? `?${query}` : ""}`);
}
