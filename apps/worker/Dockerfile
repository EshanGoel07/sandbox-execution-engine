# Worker image. Built from the monorepo root: the worker depends on the
# shared, infra and engine workspace packages.
#
# The worker shells out to `docker build` / `docker run` against the host
# daemon (mounted socket) to build the judge-* images and spawn sandboxes,
# so it needs the docker CLI.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build -w @vj/worker   # tsc -b: shared -> infra/engine -> worker
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/infra/package.json ./packages/infra/package.json
COPY --from=build /repo/packages/infra/dist ./packages/infra/dist
COPY --from=build /repo/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /repo/packages/engine/dist ./packages/engine/dist
COPY --from=build /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY apps/worker/images ./apps/worker/images
COPY apps/worker/docker-entrypoint.sh ./apps/worker/docker-entrypoint.sh
COPY db ./db
ENTRYPOINT ["sh", "apps/worker/docker-entrypoint.sh"]
