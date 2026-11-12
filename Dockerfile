# syntax=docker/dockerfile:1.7
# ==============================================================================
# OpenHuddle Single-Container Production Dockerfile (2C4G Optimized)
# Built in GitHub Actions (ghcr.io) — NEVER run tsc/vite build on 2C4G hosts!
# ==============================================================================

FROM node:22-bookworm-slim AS builder
WORKDIR /app

ENV CI=true
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

# 1. 复制工作区清单以最大化 Docker 层缓存命中率
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/core-governance/package.json packages/core-governance/tsconfig.json ./packages/core-governance/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY packages/mcp/package.json packages/mcp/tsconfig.json ./packages/mcp/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/

RUN pnpm install --frozen-lockfile

# 2. 复制全仓源码并构建所有包（包含 apps/server/public/openhuddle.mjs 与 apps/web/dist）
COPY packages ./packages
COPY apps ./apps
RUN pnpm build && pnpm prune --prod

# ==============================================================================
# Runner Stage: Lightweight Non-Root Node 22 Runtime (< 512MB V8 Heap Cap)
# ==============================================================================
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=512"

COPY --from=builder --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages ./packages
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/server/public ./apps/server/public
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/.data && chown -R node:node /app/.data

USER node
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
