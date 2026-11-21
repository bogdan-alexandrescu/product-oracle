#!/bin/sh
# #1581: renders the web's nginx config at container start (the image runs /docker-entrypoint.d/*
# before nginx). Only the two names below are replaced, so nginx's own $host, $uri and so on stay.
set -eu
: "${ORACLE_GIT_SHA:=unknown}"
export ORACLE_GIT_SHA
envsubst "\${ORACLE_GIT_SHA}" < /etc/nginx/oracle/default.conf.template > /etc/nginx/conf.d/default.conf
if [ -n "${API_INTERNAL_URL:-}" ]; then
  envsubst "\${API_INTERNAL_URL}" < /etc/nginx/oracle/api-proxy.conf.template > /etc/nginx/api-proxy.conf
else
  : > /etc/nginx/api-proxy.conf
fi
