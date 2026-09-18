# syntax=docker/dockerfile:1
# TanStack Start (Vite + Nitro, bun preset) — see
# https://tanstack.com/start/v0/docs/framework/react/guide/hosting#bun
#
# Build context is the monorepo root (set by the CDK EcsStack construct):
#   docker build -f apps/web/Dockerfile .

########################################
# Stage 1: install workspace dependencies
########################################
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app

# Copy only the manifests first so the (slow) install layer is cached
# until a dependency actually changes. Every workspace member's
# package.json must be present for bun to resolve the workspace.
COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/infra/package.json apps/infra/
COPY packages/auth/package.json packages/auth/
COPY packages/database/package.json packages/database/
COPY packages/ui/package.json packages/ui/
COPY packages/biome-config/package.json packages/biome-config/
COPY packages/typescript-config/package.json packages/typescript-config/

RUN bun install --frozen-lockfile

########################################
# Stage 2: build the app
########################################
FROM deps AS build
WORKDIR /app

COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web

# `vite build` with nitro({ preset: "bun" }) emits the self-contained
# bun server bundle at apps/web/.output (server deps inlined).
RUN cd apps/web && bun run build

########################################
# Stage 3: minimal Bun runtime
########################################
FROM oven/bun:1.3.14-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_SSL_CA_PATH=/app/rds-global-bundle.pem

# RDS certificate authorities so the server-side Aurora connection (session
# lookups via @repo/database) is fully verified. Placed in the existing
# WORKDIR: ADD --chmod also applies the mode to directories it creates, which
# would leave a new /etc/ssl/certs untraversable by the non-root `bun` user.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

# The Nitro bun output is fully self-contained — no node_modules
# or package.json needed at runtime.
COPY --from=build /app/apps/web/.output ./.output

USER bun
EXPOSE 3000

CMD ["bun", ".output/server/index.mjs"]
