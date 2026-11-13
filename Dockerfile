# syntax=docker/dockerfile:1
# Stages: deps -> build -> test (e2e runner) ; prod-deps -> runtime (LAST, so `docker build .` = production image)

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Test stage: dev dependencies + sources + configs. Used by `docker compose --profile test run tests`.
FROM build AS test
COPY vitest.config.ts eslint.config.js ./
COPY tests ./tests
ENV NODE_ENV=test
CMD ["npm", "run", "test:e2e"]

FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS runtime
RUN addgroup -g 10001 -S app && adduser -u 10001 -S -G app -h /app -s /sbin/nologin app
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    AUDIT_LOG_PATH=/app/data/audit-log.json
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
RUN mkdir -p /app/data && chown app:app /app/data && chmod 0700 /app/data
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
