import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProtocolContext } from "@averis/protocol";

const ListQuery = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  page: z.coerce.number().int().min(1).default(1),
});

const DataQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  page: z.coerce.number().int().min(1).default(1),
});

/**
 * Read-through view of the upstream data network.
 *
 * These routes are how a requester finds out what data exists before creating
 * a job. They proxy the `DataProvider` abstraction, not Reppo directly, so the
 * same endpoints serve any configured data network.
 */
export function registerDatanetRoutes(app: FastifyInstance, ctx: ProtocolContext): void {
  app.get("/v1/datanets", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters" });

    try {
      const datanets = await ctx.data.listDatanets(parsed.data);
      return reply.send({
        data: datanets.map((d) => ({
          id: d.id,
          source: d.source,
          name: d.name,
          description: d.description,
          domains: d.domains,
          curation: d.curation,
          accessFee: d.accessFee,
          thumbnailUrl: d.thumbnailUrl,
        })),
      });
    } catch (error) {
      return reply.code(502).send({
        error: "Upstream data network is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/v1/datanets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const datanet = await ctx.data.getDatanet(id);
    if (!datanet) return reply.code(404).send({ error: "Datanet not found" });
    return reply.send({ data: datanet });
  });

  app.get("/v1/datanets/:id/data", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DataQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters" });

    const items = await ctx.data.listData(id, parsed.data);
    return reply.send({
      data: items.map((item) => ({
        id: item.id,
        title: item.title,
        content: item.content.slice(0, 600),
        url: item.url,
        qualityScore: item.qualityScore,
        curation: item.curation,
        publishedAt: item.publishedAt,
      })),
    });
  });
}
