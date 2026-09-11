import "@fastify/jwt";
import type { WsHub } from "../modules/ws/ws.hub.js";

/**
 * Augments FastifyInstance with custom decorators:
 *  - authenticate  preHandler registered by @fastify/jwt
 *  - wsHub         WebSocket team-room hub (Epic 2)
 */
declare module "fastify" {
  interface FastifyInstance {
    authenticate: import("fastify").preHandlerHookHandler;
    authorizeGM: import("fastify").preHandlerHookHandler;
    /** WebSocket hub for team-scoped radius-event broadcasting. */
    wsHub: WsHub;
  }
}

/**
 * Augment @fastify/jwt types with our JWT payload structure
 */
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      accountId?: string;
      playerId?: string;
      sub?: string; // Legacy/alternative support
      teamId?: string; // For some routes
      role?: string; // For auth
      username?: string; // For auth
    };
    user: {
      accountId?: string;
      playerId?: string;
      sub?: string; // Legacy/alternative support
      teamId?: string; // For some routes
      role?: string; // For auth
      username?: string; // For auth
    };
  }
}
