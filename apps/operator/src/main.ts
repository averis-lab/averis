import "@averis/db/env";
import { disconnect } from "@averis/db";
import { createContext } from "@averis/protocol";
import { loadOperatorConfig } from "./config";
import { Operator } from "./operator";

async function main(): Promise<void> {
  const path = process.env["OPERATOR_CONFIG"] ?? "./apps/operator/operator.yaml";
  const config = await loadOperatorConfig(path);

  const ctx = createContext();
  const operator = new Operator(ctx, config);

  await operator.start();

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info("stopping operator", { signal });
    operator.stop();
    await ctx.queue.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("operator startup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
