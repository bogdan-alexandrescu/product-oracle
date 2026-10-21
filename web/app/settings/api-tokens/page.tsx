import { Suspense } from "react";

import { ApiTokensSettings } from "@/components/ApiTokensSettings";

async function Tokens({ searchParams }: { searchParams: PageProps<"/settings/api-tokens">["searchParams"] }) {
  const { member } = await searchParams;
  return <ApiTokensSettings initialMember={typeof member === "string" ? member : null} />;
}

export default function ApiTokensPage({ searchParams }: PageProps<"/settings/api-tokens">) {
  return (
    <Suspense fallback={null}>
      <Tokens searchParams={searchParams} />
    </Suspense>
  );
}
