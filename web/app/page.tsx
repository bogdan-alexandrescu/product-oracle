import { redirect } from "next/navigation";

/** The bare site URL opens Home, the rail's first destination (UI test finding E1). */
export default function Root() {
  redirect("/home");
}
