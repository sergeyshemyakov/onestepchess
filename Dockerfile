FROM node:22-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY packages/rail-avm/package.json packages/rail-avm/package.json
COPY packages/rail-mock/package.json packages/rail-mock/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/agent-kit/package.json packages/agent-kit/package.json
COPY e2e/package.json e2e/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages packages
COPY e2e e2e
RUN pnpm build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV RAIL=mock
ENV PORT=3000
ENV DB_PATH=/data/osc.sqlite
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/rail-avm/package.json ./packages/rail-avm/package.json
COPY --from=build /app/packages/rail-avm/dist ./packages/rail-avm/dist
COPY --from=build /app/packages/rail-avm/node_modules ./packages/rail-avm/node_modules
COPY --from=build /app/packages/rail-mock/package.json ./packages/rail-mock/package.json
COPY --from=build /app/packages/rail-mock/dist ./packages/rail-mock/dist
COPY --from=build /app/packages/rail-mock/node_modules ./packages/rail-mock/node_modules
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/drizzle ./packages/server/drizzle
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/web/dist ./packages/web/dist

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "packages/server/dist/index.js"]
