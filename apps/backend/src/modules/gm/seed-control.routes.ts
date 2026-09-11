/**
 * Seed Control Routes – Epic 9
 * Endpoint for GM to trigger GeoJSON re-seed.
 */

import type { FastifyPluginAsync } from "fastify";
import { SeedControlService } from "./seed-control.service.js";

export const seedControlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", fastify.authorizeGM);
  const service = new SeedControlService(fastify.log);

  // ── POST /api/v1/gm/seed/trigger ────────────────────────────────────────────
  fastify.post("/seed/trigger", async (request, reply) => {
    const actorId = request.user.accountId!;

    const report = await service.triggerReSeed(actorId);

    return reply.send(report);
  });
};
