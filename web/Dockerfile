# Images are pinned by digest (#1565), so a moved tag never changes a build: bump tag and digest together.
# #1581: Vite builds the app to static files (dist/); nginx serves them on port 3000
# (nginx/default.conf.template, docs/vite-migration/nginx.md).
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The build reads .env.production (the deploy writes it); vite.config.mts maps its flags.
RUN npm run build

# nginx 1.30.7: a security exception to the 14-day rule, approved Nov 20 (dependencies.md).
FROM nginx:1.30.7-alpine-slim@sha256:8c950211a641ec5b23f265450517001f6bcca533666120ebe36cb4cff3d00a55
COPY nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY nginx/default.conf.template nginx/api-proxy.conf.template /etc/nginx/oracle/
COPY nginx/40-oracle-config.sh /docker-entrypoint.d/40-oracle-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# The API behind /v1, /uploads and /healthz, for local and real-stack runs (docker-compose.yml);
# empty in production, where the load balancer routes those paths to the API.
ARG API_INTERNAL_URL=
ENV API_INTERNAL_URL=$API_INTERNAL_URL
# #1569: the commit this image was built from, served at /version (the deploy job passes it:
# --build-arg GIT_SHA=$GITHUB_SHA).
ARG GIT_SHA=unknown
ENV ORACLE_GIT_SHA=$GIT_SHA
EXPOSE 3000
