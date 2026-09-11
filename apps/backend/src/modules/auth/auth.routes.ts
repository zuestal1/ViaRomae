/**
 * Auth Routes
 * -----------
 * POST   /api/v1/auth/login    – exchange access code for JWT + session
 * DELETE /api/v1/auth/session  – invalidate current session (logout)
 * GET    /api/v1/auth/me       – fetch account + player + team profile
 */

import type { FastifyInstance } from "fastify";
import { LoginRequestSchema } from "@jlw/contracts";
import {
  findAccountByAccessCode,
  createSession,
  deleteSession,
  getMe,
} from "./auth.service.js";

export async function authRoutes(server: FastifyInstance): Promise<void> {
  // ── POST /login ─────────────────────────────────────────────────────────────
  server.post("/login", async (request, reply) => {
    // 1. Validate request body via shared Zod schema
    const body = LoginRequestSchema.parse(request.body);

    // 2. Find the matching account (full-scan with timing-safe comparison)
    const account = await findAccountByAccessCode(body.accessCode);
    if (!account) {
      // Return 401 with a generic message – do NOT reveal whether the code exists
      return reply.status(401).send({
        statusCode: 401,
        error: "Unauthorized",
        message: "Invalid access code",
      });
    }

    // 3. Sign a JWT (expires in 7 days, matching the session lifetime)
    const token = server.jwt.sign(
      { sub: account.id, accountId: account.id, role: account.role, username: account.username },
      { expiresIn: "7d" },
    );

    // 4. Persist the session in the database
    await createSession({ accountId: account.id, token });

    server.log.info({ accountId: account.id, role: account.role }, "User logged in");

    // 5. Return token + stripped account info
    return reply.status(200).send({
      token,
      account: { id: account.id, username: account.username, role: account.role },
    });
  });

  // ── DELETE /session (logout) ────────────────────────────────────────────────
  server.delete(
    "/session",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      // Extract the raw JWT string from the Authorization header
      const authHeader = request.headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

      if (!token) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Authorization header missing",
        });
      }

      await deleteSession(token);

      server.log.info({ accountId: (request.user as { sub: string }).sub }, "User logged out");

      return reply.status(204).send();
    },
  );

  // ── GET /me ─────────────────────────────────────────────────────────────────
  server.get(
    "/me",
    { onRequest: [server.authenticate] },
    async (request, reply) => {
      const { sub: accountId } = request.user as { sub: string };
      const me = await getMe(accountId);
      return reply.status(200).send(me);
    },
  );
}
