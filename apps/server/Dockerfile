# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/server/Dockerfile .
ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.34.5
WORKDIR /repo
# Fetch from the lockfile alone so dependency layers survive source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter kuro-server... --filter kuro-web...
RUN pnpm --filter kuro-server build && pnpm --filter kuro-web build
# The release-age policy gates *resolving* versions on a developer's machine; this reproduces a
# lockfile that already passed it, so the check is off here and only here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter kuro-server deploy --prod --config.minimum-release-age=0 --config.inject-workspace-packages=true /out

FROM ${NODE_IMAGE} AS runtime
# pg_dump for the nightly backup (KURO-REQ-060). The client must match the server's major
# version (Foreman and D3 Auth learned this in their restore drills), so it comes from PGDG.
ARG POSTGRES_MAJOR=16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-client-${POSTGRES_MAJOR} \
    && rm -rf /var/lib/apt/lists/* \
    && pg_dump --version | grep -q " ${POSTGRES_MAJOR}\."
ARG KURO_VERSION=dev
ENV NODE_ENV=production PORT=3300 WEB_DIST=/app/public KURO_VERSION=${KURO_VERSION}
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./public
RUN mkdir -p /data/images /data/backups && chown -R node:node /data
# Every runtime module must resolve from the production install: a package left in devDependencies
# fails the build here instead of crash-looping the server at boot.
RUN node --input-type=module -e "await import('/app/dist/app.js'); await import('/app/dist/jobs/queue.js');"
USER node
EXPOSE 3300
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
