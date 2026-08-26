-- The queue moves from Redis into Postgres.

-- CreateTable
CREATE TABLE "queue_dedupe" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_dedupe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "queue_dedupe_queue_createdAt_idx" ON "queue_dedupe"("queue", "createdAt");

-- pgmq ships with Supabase and only has to be switched on. Everything it
-- creates lives in the `pgmq` schema, which Prisma does not manage, so none of
-- it registers as drift against schema.prisma.
--
-- Guarded on availability, because the extension is not on every Postgres: the
-- stock `postgres:16-alpine` behind docker-compose and the integration suite
-- does not carry it. Those environments run QUEUE_DRIVER=bullmq or memory and
-- never touch these objects, so skipping is right there — and failing every
-- local migration over a queue that environment does not use would not be.
-- To exercise the pgmq driver locally, swap the compose image for one that
-- bundles the extension.
--
-- The queue names are the values of QUEUES in packages/queue/src/types.ts and
-- must stay in step with them: pgmq resolves a queue by name at call time, so a
-- rename landing here but not there fails at runtime rather than at deploy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq') THEN
    CREATE EXTENSION IF NOT EXISTS pgmq;
    PERFORM pgmq."create"('job');
    PERFORM pgmq."create"('evaluation');
    PERFORM pgmq."create"('consensus');
    PERFORM pgmq."create"('resolution');
  ELSE
    RAISE NOTICE 'pgmq is unavailable on this server; skipping queue creation. QUEUE_DRIVER=pgmq will not work here.';
  END IF;
END
$$;
