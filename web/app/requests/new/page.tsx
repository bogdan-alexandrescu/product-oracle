import { redirect } from "next/navigation";

/**
 * rirs-36: the To decide tab moved to /requests/to-decide; an old link (with its ?request=)
 * lands there. qa4-work-18: typed bare, /requests/new opens the New request form over All
 * requests, the list a person starts from, not over To decide.
 */
export default async function OldToDecidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const one of [v].flat()) if (one !== undefined) params.append(k, one);
  if (!params.size) redirect("/requests?compose=request");
  redirect(`/requests/to-decide?${params.toString()}`);
}
