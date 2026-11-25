# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS node-dependencies

WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund


FROM python:3.13-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="Suunto Cloud Training Analysis" \
      org.opencontainers.image.version="1.3.0" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/suunto

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        libatomic1 \
        libstdc++6 \
        tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 suunto \
    && useradd --uid 1000 --gid 1000 --create-home suunto

COPY --from=node-dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=node-dependencies /usr/local/LICENSE /usr/local/share/doc/node/LICENSE

WORKDIR /app/suunto-cloud
COPY --from=node-dependencies /dependencies/node_modules ./node_modules
COPY suunto_cloud ./suunto_cloud
COPY sync.py LICENSE THIRD_PARTY_NOTICES.md package.json package-lock.json ./

RUN mkdir -p .local /app/reports /app/visualizations \
    && chown suunto:suunto .local /app/reports /app/visualizations \
    && chmod 0700 .local /app/reports /app/visualizations

USER 1000:1000
RUN node -e "require('./suunto_cloud/fit/export_gpx.cjs').loadParser()" \
    && python3 -m suunto_cloud --help

ENTRYPOINT ["python3", "-m", "suunto_cloud"]
CMD ["--help"]


FROM node:24-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/tsconfig.json ./
COPY web/client ./client
COPY web/server ./server
COPY web/shared ./shared
RUN npm run check && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund


FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY --from=web-build /build/web/package.json ./
COPY --from=web-build /build/web/node_modules ./node_modules
COPY --from=web-build /build/web/server ./server
COPY --from=web-build /build/web/shared ./shared
COPY --from=web-build /build/web/dist ./dist
COPY --from=node-dependencies /dependencies/node_modules /app/node_modules
COPY suunto_cloud/fit/*.cjs /app/suunto_cloud/fit/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production SUUNTO_WEB_DIST=/app/web/dist
USER 1000:1000
ENTRYPOINT ["sh", "-c", "umask 077 && exec node server/main.ts"]


FROM runtime AS worker
COPY web/package.json ./web/
COPY web/server ./web/server
COPY web/shared ./web/shared
ENV NODE_ENV=production
ENTRYPOINT ["sh", "-c", "umask 077 && exec node web/server/worker.ts"]


FROM runtime AS test
COPY tests ./tests
COPY scripts/update-test-badge.py ./scripts/update-test-badge.py
COPY docs/badges/tests.svg ./docs/badges/tests.svg
RUN python3 -m unittest discover -s tests -t . -v \
    && python3 scripts/update-test-badge.py --check


FROM runtime AS app
