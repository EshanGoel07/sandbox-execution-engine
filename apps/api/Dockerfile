# API gateway image. Built from the monorepo root: the API depends on the
# shared and infra workspace packages and installs through the root lockfile.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build -w @vj/api   # tsc -b: shared -> infra -> api (project references)
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/infra/package.json ./packages/infra/package.json
COPY --from=build /repo/packages/infra/dist ./packages/infra/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY db ./db
# The public API's spec, served at /api/openapi.yaml and rendered at /api/docs.
COPY openapi.yaml ./openapi.yaml
EXPOSE 3000
CMD ["node", "apps/api/dist/api-server.js"]
