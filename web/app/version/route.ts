// #1569: the commit this image was built from (web/Dockerfile's GIT_SHA), without signing in:
// the deploy's containment check (scripts/deploy-serves.ts) asks it. The API serves its own.
import { connection } from 'next/server';

export async function GET() {
  // Read at request time, never prerendered at build (the stamp is the image's, not the build's).
  await connection();
  return Response.json(
    { git_sha: process.env.ORACLE_GIT_SHA || 'unknown' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
