# Images are pinned by digest (#1565), so a moved tag never changes a build: bump tag and digest together.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Rewrites are resolved at build time: /v1/* is proxied to this URL.
ARG API_INTERNAL_URL=http://api:8000
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
# HOSTNAME: the standalone server binds to it; Docker sets it to the container id.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# #1569: the commit this image was built from, served at /version (the deploy job passes it:
# --build-arg GIT_SHA=$GITHUB_SHA).
ARG GIT_SHA=unknown
ENV ORACLE_GIT_SHA=$GIT_SHA
EXPOSE 3000
CMD ["node", "server.js"]
