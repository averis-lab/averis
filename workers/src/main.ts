import "@averis/db/env";
import { createContext, consoleLogger } from "@averis/protocol";
import { disconnect } from "@averis/db";
import { startWorkers } from "./index";

/**
 * Runs all four lifecycle workers in a process of their own.
 *
 * This is the split deployment: the API accepts work and these machines do it,
 * which requires a queue both sides can see — `QUEUE_DRIVER=pgmq` or `bullmq`,
 * never `memory`. For a single-machine deployment the API hosts the workers
 * itself and this entrypoint is simply not run.
 */
async function main(): Promise<void> {
  const ctx = createContext({ logger: consoleLogger });
  const workers = startWorkers(ctx);

  ctx.logger.info("workers started", {
    queue: ctx.queue.name,
    data: ctx.data.name,
    llm: process.env["LLM_PROVIDER"] ?? "mock",
  });

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info("shutting down workers", { signal });
    await workers.stop();
    await ctx.queue.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("worker startup failed:", error);
  process.exit(1);
});
