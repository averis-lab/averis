import "@averis/db/env";
import { disconnect } from "@averis/db";
import { createContext } from "@averis/protocol";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const ctx = createContext();
  const app = await buildServer({ ctx });

  const port = Number(process.env["API_PORT"] ?? 4000);
  const host = process.env["API_HOST"] ?? "0.0.0.0";

  await app.listen({ port, host });
  app.log.info(
    { queue: ctx.queue.name, data: ctx.data.name, llm: process.env["LLM_PROVIDER"] ?? "mock" },
    "api gateway listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
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
