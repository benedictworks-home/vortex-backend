# syntax=docker/dockerfile:1.9
# ─── Vortex Backend — Hardened Multi-Stage Image (Issue #491) ────────────────
#
# Stages
# ──────
# 1. deps       Install all dependencies (dev + prod) for the build tools
# 2. build      Compile TypeScript, generate Prisma client (both arch targets)
# 3. prod-deps  Install production-only dependencies (no dev toolchain)
# 4. runtime    Distroless (nonroot) final image — no shell, no package manager
#
# Build targets
# ─────────────
# Default (production):
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/… .
#
# Canary (synthetic lifecycle monitor):
#   docker buildx build --target canary --platform linux/amd64,linux/arm64 -t ghcr.io/…:canary .
#
# Architecture notes
# ──────────────────
# Prisma generates architecture-specific query engine binaries. The
# `binaryTargets` in prisma/schema.prisma declares both debian-openssl-3.0.x
# (amd64) and linux-arm64-openssl-3.0.x so that `prisma generate` (run in the
# build stage on x86_64) pre-fetches both engines. The correct binary is
# selected at runtime by Prisma's engine-resolver based on the actual platform.
#
# The distroless/nodejs20-debian12 base includes:
#   • Node.js 20 + libc (glibc)
#   • libssl3 (OpenSSL 3.x) — required by Prisma query engine + OTel
#   • No shell, no package manager, no curl, no apt
#   • Runs as non-root user (uid 65532 "nonroot") by default
#
# Read-only filesystem
# ────────────────────
# The runtime stage sets no WORKDIR writes at boot. All runtime writes go to:
#   /tmp           — tmpfs (ephemeral, via k8s securityContext)
#   Prisma engines — pre-copied to /app/node_modules/.prisma at build time
# Deploy k8s with:
#   securityContext.readOnlyRootFilesystem: true
#   volumes: [{name: tmp, emptyDir: {}}, volumeMounts: [{mountPath: /tmp}]]

# ── Global build args ─────────────────────────────────────────────────────────
ARG NODE_VERSION=20
ARG DISTROLESS_TAG=nodejs20-debian12

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps
# Install ALL dependencies (dev + prod) so `nest build` and `prisma generate`
# are available. This layer is cached aggressively; it only invalidates when
# package*.json or prisma/schema.prisma changes.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Install native build toolchain needed by some npm packages (bcrypt, etc.)
# The build stage runs on the host arch; cross-compilation binaries are fetched
# by Prisma directly (see binaryTargets).
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so npm install is cached unless they change
COPY package*.json ./
COPY packages/solver-sdk/package.json ./packages/solver-sdk/

# Install all deps (dev + prod) — required for NestJS CLI and Prisma generator
RUN npm ci --ignore-scripts=false && npm cache clean --force

# Copy Prisma schema so generate runs against the correct schema
COPY prisma ./prisma

# Generate Prisma client for BOTH architectures in one pass so the runtime
# image gets the correct native binary regardless of which arch it lands on.
# binaryTargets in schema.prisma must include:
#   "debian-openssl-3.0.x"       (amd64, distroless debian12)
#   "linux-arm64-openssl-3.0.x"  (arm64, distroless debian12)
# The native binary for the current build host is also generated automatically.
RUN npx prisma generate

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — build
# Compile TypeScript → dist/. Reuses the layer cache from deps.
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

# Copy full source tree after prisma generate so the generated client is present
COPY . .

# Compile. Outputs to dist/ as configured in nest-cli.json / tsconfig.build.json
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — prod-deps
# Install production-only dependencies on a clean layer. Keeping this separate
# from the build stage means the final copy contains no dev toolchain (NestJS
# CLI, ts-jest, TypeScript, Prisma dev CLI) while still sharing the base OS
# layer cache with `deps`.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY packages/solver-sdk/package.json ./packages/solver-sdk/

# --omit=dev excludes all devDependencies; --ignore-scripts=false allows Prisma
# to run its own postinstall (engine download fallback, if any).
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

# Install the exact version of the Prisma CLI that generated these migrations.
# `prisma` is a devDependency; pinning here prevents `npx prisma` from fetching
# an incompatible version from npm at container start time (issue #497).
RUN npm install --no-save --omit=dev \
      "prisma@$(node -p "require('./package.json').devDependencies.prisma")" \
    && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — runtime  (DEFAULT TARGET)
# Distroless Node 20 running as non-root. No shell. No package manager.
# Size target: ≥50% smaller than node:20-alpine runtime.
# ─────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/${DISTROLESS_TAG}:nonroot AS runtime

# WORKDIR creates the directory under the nonroot user context
WORKDIR /app

ENV NODE_ENV=production

# ── Copy production assets from earlier stages ────────────────────────────────

# Production node_modules (no dev toolchain)
COPY --from=prod-deps /app/node_modules          ./node_modules

# Compiled application
COPY --from=build     /app/dist                  ./dist

# Prisma client + both arch query engine binaries
COPY --from=build     /app/node_modules/.prisma  ./node_modules/.prisma
COPY --from=build     /app/node_modules/@prisma  ./node_modules/@prisma

# Migration files (needed by `migrate deploy` at container start)
COPY --from=build     /app/prisma                ./prisma

# Migration entrypoint (issue #497) — ships in the runtime image so the
# pre-deploy Kubernetes Job runs exactly the same binary as the server.
COPY --from=build     /app/scripts               ./scripts

# Package manifests (needed by db-migrate-locked.js to resolve the Prisma pin)
COPY                  package.json               ./package.json

# ── Security hardening ────────────────────────────────────────────────────────
# • USER is set by the distroless:nonroot tag (uid=65532 gid=65532)
#   No explicit USER directive needed — distroless defaults to nonroot.
# • No shell → CMD must use exec-form (JSON array), not shell-form string.
# • Read-only root filesystem: no writes happen inside /app at runtime.
#   Prisma writes query-engine PID files to /tmp; mount as tmpfs in k8s.

EXPOSE 4000

# ── Health probes ─────────────────────────────────────────────────────────────
# HEALTHCHECK for local `docker run` and Docker Compose. Kubernetes ignores
# HEALTHCHECK in favour of its own liveness/readiness probes (defined in the
# Helm chart), but having it here ensures `docker ps` and smoke tests report
# healthy.
#
# • /health/live — NestJS event-loop liveness (never fails on dependency outage)
# • interval 30s, timeout 5s, start-period 45s (migrations + OTel boot)
# • 3 retries before marking unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", \
       "require('http').get('http://localhost:4000/health/live', r => { \
         if (r.statusCode !== 200) process.exit(1); \
       }).on('error', () => process.exit(1))"]

# ── Entrypoint ────────────────────────────────────────────────────────────────
# 1. Run pending migrations via the advisory-locked entrypoint (issue #497)
# 2. Start the NestJS server
#
# Exec-form is required because there is no shell in the distroless image.
# The two commands are chained at the OS level via /bin/sh — but distroless
# has no shell. We use `node -e` to execute both steps sequentially.
CMD ["/nodejs/bin/node", "-e", \
     "const {spawnSync}=require('child_process'); \
      const m=spawnSync('/nodejs/bin/node',['scripts/db-migrate-locked.js'],{stdio:'inherit'}); \
      if(m.status!==0)process.exit(m.status??1); \
      require('./dist/main.js')"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5 — canary  (issue #496)
# Synthetic lifecycle monitor. Built with --target canary.
# Reuses prod-deps and build stages; runs via the Node binary in distroless.
# ─────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/${DISTROLESS_TAG}:nonroot AS canary
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules  ./node_modules
COPY --from=build     /app/dist          ./dist
COPY --from=build     /app/tools         ./tools

# tsx is a devDependency; include it for the canary runner
COPY --from=build /app/node_modules/.bin/tsx    ./node_modules/.bin/tsx
COPY --from=build /app/node_modules/tsx         ./node_modules/tsx

CMD ["/nodejs/bin/node", "tools/canary/canary.js"]
