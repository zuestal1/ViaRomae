/**
 * Event Lifecycle Routes – Epic 9
 * Endpoints for event control (START/PAUSE/END) and leaderboard.
 */

import type { FastifyPluginAsync } from "fastify";
import { EventLifecycleService } from "./event-lifecycle.service.js";
import { ToggleLeaderboardFreezeBodySchema } from "@jlw/contracts";

export const eventLifecycleRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new EventLifecycleService(fastify.log);

  // ── GET /api/v1/gm/event/state ──────────────────────────────────────────────
  fastify.get("/event/state", async (request, reply) => {
    const state = await service.getState();
    return reply.send(state);
  });

  // ── POST /api/v1/gm/event/start ─────────────────────────────────────────────
  fastify.post("/event/start", async (request, reply) => {
    const actorId = request.user.accountId!;
    const state = await service.startEvent(actorId);
    return reply.send(state);
  });

  fastify.post("/event/day-2/start", async (request, reply) => {
    const result = await service.startDay2(request.user.accountId!);
    return reply.send(result);
  });

  // ── POST /api/v1/gm/event/pause ─────────────────────────────────────────────
  fastify.post("/event/pause", async (request, reply) => {
    const actorId = request.user.accountId!;
    const state = await service.pauseEvent(actorId);
    return reply.send(state);
  });

  // ── POST /api/v1/gm/event/resume ────────────────────────────────────────────
  fastify.post("/event/resume", async (request, reply) => {
    const actorId = request.user.accountId!;
    const state = await service.resumeEvent(actorId);
    return reply.send(state);
  });

  // ── POST /api/v1/gm/event/end ───────────────────────────────────────────────
  fastify.post("/event/end", async (request, reply) => {
    const actorId = request.user.accountId!;
    const state = await service.endEvent(actorId);
    return reply.send(state);
  });

  // ── GET /api/v1/gm/event/leaderboard ────────────────────────────────────────
  fastify.get("/event/leaderboard", async (request, reply) => {
    const leaderboard = await service.getLeaderboard();
    return reply.send(leaderboard);
  });

  // ── GET /api/v1/gm/event/summary ────────────────────────────────────────────
  fastify.get("/event/summary", async (request, reply) => {
    const summary = await service.getSummary();
    return reply.send(summary);
  });

  // ── POST /api/v1/gm/event/leaderboard-freeze ────────────────────────────────
  fastify.post("/event/leaderboard-freeze", async (request, reply) => {
    const actorId = request.user.accountId!;
    const { freeze } = ToggleLeaderboardFreezeBodySchema.parse(request.body);

    const state = await service.toggleLeaderboardFreeze(actorId, freeze);
    return reply.send(state);
  });
};
