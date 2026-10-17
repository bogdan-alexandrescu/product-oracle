FROM python:3.12-slim

# WeasyPrint (PDF export) needs Pango/HarfBuzz at runtime, plus fonts: the slim image
# ships none, and the export stylesheet uses DejaVu.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Claude Code, for Oracle's own model calls on a user's Claude plan: oracle.llm runs
# `claude -p` headless with that user's `claude setup-token` value
# (CLAUDE_CODE_OAUTH_TOKEN, set for that one process). Node comes from the official
# image; the CLI is pinned so a rebuild never changes the headless flags under us.
ARG CLAUDE_CODE_VERSION=2.1.283
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
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

EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn oracle.main:app --host 0.0.0.0 --port 8000"]
