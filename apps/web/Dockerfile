# Build the SPA (with the API base baked in) from the monorepo root, then
# serve the static files with nginx. Build context is the repo root because
# the app imports shared types from packages/shared and installs through the
# root workspace lockfile.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
# Where the browser should reach the API. For the local docker-compose stack
# the browser runs on the host, so it's the host-published port.
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w @vj/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
