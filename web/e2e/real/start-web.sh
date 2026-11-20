#!/bin/sh
# #1582: the real-stack suite's web server: the production build (dist-e2e) served by nginx
# with the image's own config (nginx/), on E2E_WEB_PORT, proxying /v1 to E2E_API_URL.
# Uses the nginx on PATH; without one, the image's pinned nginx through Docker (host network).
set -eu
cd "$(dirname "$0")/../.."
npx vite build --mode e2e
CONF="${TMPDIR:-/tmp}/oracle-e2e-nginx"
rm -rf "$CONF" && mkdir -p "$CONF/conf.d" "$CONF/run"
ROOT="$(pwd)/dist-e2e"
sed -e "s#listen 3000;#listen ${E2E_WEB_PORT};#" -e "s#root /usr/share/nginx/html;#root ${ROOT};#" \
  -e "s#/etc/nginx/security-headers.conf#${CONF}/security-headers.conf#g" \
  -e "s#/etc/nginx/api-proxy.conf#${CONF}/api-proxy.conf#" \
  -e 's#${ORACLE_GIT_SHA}#unknown#' nginx/default.conf.template > "$CONF/conf.d/default.conf"
cp nginx/security-headers.conf "$CONF/security-headers.conf"
sed -e "s#\${API_INTERNAL_URL}#${E2E_API_URL}#" nginx/api-proxy.conf.template > "$CONF/api-proxy.conf"
cat > "$CONF/nginx.conf" <<NGINX
daemon off;
pid ${CONF}/run/nginx.pid;
error_log stderr;
events {}
http {
  types { text/html html; text/css css; application/javascript js; application/json json;
          image/svg+xml svg; image/png png; font/woff2 woff2; }
  default_type application/octet-stream;
  access_log off;
  client_body_temp_path ${CONF}/run/body;
  proxy_temp_path ${CONF}/run/proxy;
  include ${CONF}/conf.d/*.conf;
}
NGINX
if command -v nginx >/dev/null 2>&1; then
  exec nginx -p "$CONF" -c "$CONF/nginx.conf"
fi
exec docker run --rm --network host -v "$CONF:$CONF" -v "$ROOT:$ROOT:ro" \
  nginx:1.30.7-alpine-slim@sha256:8c950211a641ec5b23f265450517001f6bcca533666120ebe36cb4cff3d00a55 \
  nginx -p "$CONF" -c "$CONF/nginx.conf"
