// #1569: the commit this image was built from (web/Dockerfile's GIT_SHA), without signing in:
// the deploy's containment check (scripts/deploy-serves.ts) asks it. The API serves its own.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { git_sha: process.env.ORACLE_GIT_SHA || "unknown" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
