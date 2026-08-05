# ── Stage 1: install all deps (including devDeps for build) ──────────────────
FROM node:26-alpine AS builder
WORKDIR /app

# Workspace manifests first so the install layer caches across source changes.
# pnpm-workspace.yaml is not optional here, and its absence is SILENT: besides
# the workspace globs it carries the public-hoist patterns for the three
# serverExternalPackages (pdfkit, exceljs, z3-solver). Leave it out and the
# install succeeds, `next build` succeeds, and the standalone server cannot
# resolve any of them at runtime — z3 then falls back to LLM repair, which is a
# designed path, so nothing surfaces an error.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
# node 26 dropped corepack, so pnpm is installed explicitly rather than activated.
RUN npm i -g pnpm@10.34.5
# BuildKit cache mount over pnpm's content-addressed store: it persists on the
# Fly builder disk between deploys, so a lockfile change re-fetches only what
# actually changed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY . .

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Pass them via fly.toml [build.args] or `fly deploy --build-arg`.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL

# Sentry source-map upload during `next build` (next.config.js). ORG/PROJECT
# come from fly.toml [build.args]; AUTH_TOKEN is passed via `fly deploy
# --build-arg` from CI — it is a SECRET, never committed. Upload self-disables
# when SENTRY_AUTH_TOKEN is absent (local builds).
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN

# tsc gates types in CI; the in-build checker (the 6 GB-heap worker that
# SIGKILLed on builder VMs) is skipped here.
RUN SKIP_TYPECHECK=1 npm run build --workspace apps/web

# ── Stage 2: minimal production image ────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# standalone output + static assets + public dir
# (outputFileTracingRoot = repo root, so standalone mirrors the monorepo layout:
#  server.js lives at apps/web/server.js inside the standalone folder)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static    ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public          ./apps/web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
