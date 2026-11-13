# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS node-dependencies

WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund


FROM python:3.13-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="Suunto Cloud Training Analysis" \
      org.opencontainers.image.version="1.0.0" \
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


FROM runtime AS test
COPY tests ./tests
COPY scripts/update-test-badge.py ./scripts/update-test-badge.py
COPY docs/badges/tests.svg ./docs/badges/tests.svg
RUN python3 -m unittest discover -s tests -t . -v \
    && python3 scripts/update-test-badge.py --check


FROM runtime AS app
