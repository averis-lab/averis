# Shared image for the API, workers and operator services.
FROM node:24-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json          apps/api/package.json
COPY apps/operator/package.json     apps/operator/package.json
COPY apps/web/package.json          apps/web/package.json
COPY workers/package.json           workers/package.json
COPY packages/types/package.json          packages/types/package.json
COPY packages/db/package.json             packages/db/package.json
COPY packages/queue/package.json          packages/queue/package.json
COPY packages/reppo-adapter/package.json  packages/reppo-adapter/package.json
COPY packages/agent-runtime/package.json  packages/agent-runtime/package.json
COPY packages/consensus/package.json      packages/consensus/package.json
COPY packages/reputation/package.json     packages/reputation/package.json
COPY packages/strategy/package.json       packages/strategy/package.json
COPY packages/budget/package.json         packages/budget/package.json
COPY packages/sdk/package.json            packages/sdk/package.json
RUN npm ci --ignore-scripts

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prisma.config.ts` resolves DATABASE_URL eagerly and throws when it is
# missing, but `generate` never connects to anything — it only reads the schema.
# The value is supplied inline for this one command, so nothing is baked into
# the image and the runtime still has to provide a real one. (This build
# previously succeeded only because .env was being copied in, which is the leak
# .dockerignore now closes.)
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# One image serves all four processes, so the web build happens here too. The
# API and the workers simply never run it.
RUN npm run build

# 4000 API · 3000 web
EXPOSE 4000 3000

# The API is the default service; workers and the operator run from this same
# image with the command overridden. `start` runs the entrypoint directly —
# `dev` is `tsx watch`, which in a container watches files that can never
# change and restarts a worker that may be mid-job.
CMD ["npm", "run", "start", "--workspace", "@averis/api"]
