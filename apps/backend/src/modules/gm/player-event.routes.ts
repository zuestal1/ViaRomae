import type { FastifyInstance } from "fastify";
import { EventLifecycleService } from "./event-lifecycle.service.js";
import { getRuntimeEventState } from "./event-runtime.service.js";

export async function playerEventRoutes(server: FastifyInstance): Promise<void> {
  const service = new EventLifecycleService(server.log);
  server.get("/state", { onRequest: [server.authenticate] }, async () => getRuntimeEventState());
  server.get("/leaderboard", { onRequest: [server.authenticate] }, async () => {
    const rows = await service.getVisibleLeaderboard();
    return rows.map(({ teamId: _teamId, ...entry }) => entry);
  });
}
