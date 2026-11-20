# Images are pinned by digest (#1565), so a moved tag never changes a build: bump tag and digest together.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# WeasyPrint (PDF export) needs Pango/HarfBuzz at runtime, plus fonts: the slim image
# ships none, and the export stylesheet uses DejaVu.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 /uv /uvx /bin/

# Claude Code, for Oracle's own model calls on a user's Claude plan: oracle.llm runs
# `claude -p` headless with that user's `claude setup-token` value
# (CLAUDE_CODE_OAUTH_TOKEN, set for that one process). Node comes from the official
# image; the CLI is pinned so a rebuild never changes the headless flags under us.
ARG CLAUDE_CODE_VERSION=2.1.283
COPY --from=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && claude --version
ENV DISABLE_AUTOUPDATER=1

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev
# UV_COMPILE_BYTECODE compiles the installed packages only; the app itself is an editable
# install and .dockerignore drops __pycache__, so without this every new instance compiled
# all of oracle/ (and the migration scripts) before it could serve.
RUN python -m compileall -q oracle migrations

# #1569: the commit this image was built from, served at /version (the deploy job passes it:
# --build-arg GIT_SHA=$GITHUB_SHA). Last, so a new commit rebuilds no layer above.
ARG GIT_SHA=unknown
ENV ORACLE_GIT_SHA=$GIT_SHA

EXPOSE 8000
# oracle.startup: brings the database to head (Alembic only when it is not there), then
# serves on 8000 in the same process. On Cloud Run the deploy job migrates in its own step
# (`python -m oracle.startup migrate`) and sets ORACLE_MIGRATE_AT_START=0: a start never migrates.
CMD ["python", "-m", "oracle.startup"]
