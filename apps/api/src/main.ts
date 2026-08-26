import "@averis/db/env";
import { disconnect } from "@averis/db";
import { createContext } from "@averis/protocol";
import { startWorkers, type WorkerSet } from "@averis/workers";
import { buildServer } from "./server";

/**
 * Whether this process should also run the lifecycle workers.
 *
 * Explicit opt-in, with one automatic case: the in-memory queue driver exists
 * only inside a single process, so an API using it without workers alongside
 * accepts jobs that nothing will ever pick up — and does so silently, which is
 * the worst way for a pipeline to be broken. Defaulting it on there turns a
 * silent misconfiguration into a working single-process deployment.
 */
function wantsInProcessWorkers(env: NodeJS.ProcessEnv): boolean {
  const raw = env["WORKERS_IN_PROCESS"];
  if (raw !== undefined && raw !== "") {
    return raw === "1" || raw.toLowerCase() === "true";
  }
  return (env["QUEUE_DRIVER"] ?? "pgmq").toLowerCase() === "memory";
}

async function main(): Promise<void> {
  const ctx = createContext();
  const app = await buildServer({ ctx });

  // Started before listen: a machine that is accepting requests should already
  // be draining the queue, not still wiring itself up.
  const workers: WorkerSet | undefined = wantsInProcessWorkers(process.env)
    ? startWorkers(ctx)
    : undefined;

  const port = Number(process.env["API_PORT"] ?? 4000);
  const host = process.env["API_HOST"] ?? "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(
    {
      queue: ctx.queue.name,
      data: ctx.data.name,
      llm: process.env["LLM_PROVIDER"] ?? "mock",
      workers: workers ? "in-process" : "separate",
    },
    "api gateway listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    // Order matters: stop accepting requests, then stop taking new messages,
    // then release the connections both were using.
    await app.close();
    await workers?.stop();
    await ctx.queue.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("api startup failed:", error);
  process.exit(1);
});
