import { notFound } from "next/navigation";

/**
 * F-32: a wrong URL under Settings ("/settings/bad") is not-found inside Settings' layout, so the
 * Settings tabs stay above it (as a missing run keeps Runs' page), not the bare root not-found.
 */
export default function MissingSettingsPage(): never {
  notFound();
}
