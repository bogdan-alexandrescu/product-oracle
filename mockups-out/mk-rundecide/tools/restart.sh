#!/bin/bash
# stop the mock server by its process group, rebuild, restart
for p in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
  case "$c" in
    "npm run start:mock"*)
      PG=$(sed 's/.*) //' "$p/stat" | cut -d' ' -f3)
      kill -- -"$PG"
      ;;
  esac
done
sleep 2
cd "$(dirname "$0")/../../../web" || exit 1
npm run build:mock > "$TMPDIR/build.log" 2>&1 || { tail -30 "$TMPDIR/build.log"; exit 1; }
(E2E_PORT=3393 PORT=3393 setsid npm run start:mock > "$TMPDIR/server.log" 2>&1 &)
sleep 5; curl -s -o /dev/null -w "%{http_code}\n" localhost:3393/simple
