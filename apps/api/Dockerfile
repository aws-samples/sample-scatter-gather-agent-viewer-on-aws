# syntax=docker/dockerfile:1
FROM oven/bun:1.4-slim AS build

WORKDIR /app

# Cache the install layer. Every workspace member's package.json must be
# present for bun to resolve the "workspace:*" deps (@repo/auth, @repo/database).
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

# Sources. tsconfig.json is required at build time so bun can resolve the
# "@/*" path alias used by src/index.ts.
COPY packages ./packages
COPY apps/api ./apps/api

ENV NODE_ENV=production

# --target bun-linux-arm64 matches the ARM64 runtimePlatform set on the
# Fargate task definition in apps/infra/lib/construct/api.ts.
RUN cd apps/api && bun build \
	--compile \
	--minify-whitespace \
	--minify-syntax \
	--target bun-linux-arm64 \
	--outfile /app/server \
	src/index.ts

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=build /app/server server

# RDS certificate authorities so the Aurora TLS connection is fully verified
# (@repo/database reads DB_SSL_CA_PATH). Kept in the existing WORKDIR so
# ADD --chmod does not create untraversable parent directories.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

ENV NODE_ENV=production \
	PORT=4000 \
	DB_SSL_CA_PATH=/app/rds-global-bundle.pem

CMD ["./server"]

EXPOSE 4000
