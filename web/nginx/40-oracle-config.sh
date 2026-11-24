#!/bin/sh
# #1581: renders the web's nginx config at container start (the image runs /docker-entrypoint.d/*
# before nginx). Only the two names below are replaced, so nginx's own $host, $uri and so on stay.
# ORACLE_NGINX_DIR (default /etc/nginx) is for lib/nginx-config.test.ts only.
set -eu
dir=${ORACLE_NGINX_DIR:-/etc/nginx}
: "${ORACLE_GIT_SHA:=unknown}"
export ORACLE_GIT_SHA
envsubst "\${ORACLE_GIT_SHA}" < "$dir/oracle/default.conf.template" > "$dir/conf.d/default.conf"
if [ -n "${API_INTERNAL_URL:-}" ]; then
  envsubst "\${API_INTERNAL_URL}" < "$dir/oracle/api-proxy.conf.template" > "$dir/api-proxy.conf"
else
  # #1708: no API behind this image (production: the load balancer routes these to the API). A
  # path it misroutes here is a 404, never the app shell with a 200.
  printf '%s\n' \
    'location ^~ /v1/ { return 404; }' \
    'location ^~ /uploads/ { return 404; }' > "$dir/api-proxy.conf"
fi
