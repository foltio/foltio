# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS web-build
COPY server ./server
COPY web ./web
RUN npm run web:build

FROM node:26-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg melt ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY migrations ./migrations
COPY scripts ./scripts
COPY server ./server
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 8810
CMD ["node", "server/index.mjs"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
EXPOSE 80
