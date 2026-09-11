/**
 * Backend entry point — Fastify server.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwtPlugin from "@fastify/jwt";
import websocketPlugin from "@fastify/websocket";

import { authRoutes } from "./modules/auth/auth.routes.js";
import { geoRoutes } from "./modules/geo/geo.routes.js";
import { questRoutes } from "./modules/quest/quest.routes.js";
import { combatRoutes } from "./modules/combat/combat.routes.js";
import { bossRoutes } from "./modules/combat/boss.routes.js";
import { economyRoutes } from "./modules/economy/economy.routes.js";
import { storeRoutes } from "./modules/economy/store.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";
import { wsRoutes } from "./modules/ws/ws.routes.js";
import { gmCommandsRoutes } from "./modules/gm/gm-commands.routes.js";
import { eventLifecycleRoutes } from "./modules/gm/event-lifecycle.routes.js";
import { gmDashboardRoutes } from "./modules/gm/gm-dashboard.routes.js";
import { seedControlRoutes } from "./modules/gm/seed-control.routes.js";
import { classRoutes } from "./modules/classes/class.routes.js";
import { classSelectionRoutes } from "./modules/player/class-selection.routes.js";
import { errorHandler } from "./plugins/error-handler.js";
import { WsHub } from "./modules/ws/ws.hub.js";
import { WsEventCleanup } from "./modules/ws/ws.cleanup.js";

const HOST = process.env["HOST"] ?? "0.0.0.0";
const PORT = Number(process.env["PORT"] ?? 3000);

const server = Fastify({
  logger: {
    level: process.env["LOG_LEVEL"] ?? "info",
  },
});

// ── Plugins ──────────────────────────────────────────────────────────────────
await server.register(helmet);
await server.register(cors, { origin: true });
await server.register(jwtPlugin, {
  secret: process.env["JWT_SECRET"] ?? "changeme-dev-secret",
});
await server.register(websocketPlugin);

// ── Authenticate decorator (used as preHandler in protected routes) ────────
server.decorate(
  "authenticate",
  async function (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      void reply.send(err);
    }
  },
);

// ── WebSocket Hub (Epic 2 + Epic 7) ───────────────────────────────────────
const wsHub = new WsHub(server.log);
server.decorate("wsHub", wsHub);

// Start event log cleanup job (Epic 7)
const wsCleanup = new WsEventCleanup(server.log);
wsCleanup.start();

// Clean up on server close
server.addHook("onClose", () => {
  wsHub.destroy();
  wsCleanup.stop();
});

// ── Body parsers ──────────────────────────────────────────────────────────────
// Allow empty JSON bodies (e.g. POST /complete with no payload).
server.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  function (_req, body, done) {
    if (!body || (body as string).trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

// Accept form-urlencoded and any other content-type on no-body routes (e.g. POST /complete).
server.addContentTypeParser(
  ["application/x-www-form-urlencoded", "text/plain"],
  { parseAs: "string" },
  function (_req, _body, done) {
    done(null, {});
  },
);

// ── Error handler ─────────────────────────────────────────────────────────────
server.setErrorHandler(errorHandler);

// ── Routes ────────────────────────────────────────────────────────────────────
await server.register(authRoutes, { prefix: "/api/v1/auth" });
await server.register(geoRoutes, { prefix: "/api/v1/geo" });
await server.register(questRoutes, { prefix: "/api/v1/quests" });
await server.register(combatRoutes, { prefix: "/api/v1/combat" });
await server.register(bossRoutes, { prefix: "/api/v1/boss" });
await server.register(economyRoutes, { prefix: "/api/v1/economy" });
await server.register(storeRoutes, { prefix: "/api/v1/stores" });
await server.register(inventoryRoutes, { prefix: "/api/v1/inventory" });
await server.register(mediaRoutes, { prefix: "/api/v1/media" });
await server.register(wsRoutes, { prefix: "/api/v1/ws" });
await server.register(classSelectionRoutes, { prefix: "/api/v1/class-selection" });

// GM Routes (Epic 9)
await server.register(gmCommandsRoutes, { prefix: "/api/v1/gm" });
await server.register(eventLifecycleRoutes, { prefix: "/api/v1/gm" });
await server.register(gmDashboardRoutes, { prefix: "/api/v1/gm" });
await server.register(seedControlRoutes, { prefix: "/api/v1/gm" });
await server.register(classRoutes, { prefix: "/api/v1/classes" });

// ── Health check ──────────────────────────────────────────────────────────────
server.get("/health", async () => ({ status: "ok" }));

// ── WebSocket diagnostics (dev / GM use) ──────────────────────────────────────
server.get("/health/ws", async () => ({
  status: "ok",
  connections: server.wsHub.connectionCount,
  rooms: server.wsHub.getRoomStats(),
}));

// ── Start ─────────────────────────────────────────────────────────────────────
try {
  await server.listen({ port: PORT, host: HOST });
  server.log.info(`Server running at http://${HOST}:${PORT}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
