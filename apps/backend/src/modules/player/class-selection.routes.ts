import type { FastifyInstance } from "fastify";
import { ConfirmClassRequestSchema, GMClassOverrideRequestSchema, SelectClassRequestSchema } from "@jlw/contracts";
import { classSelectionService, type ClassSelectionService } from "./class-selection.service.js";

const accountId = (user: { sub?: string }) => {
  if (!user.sub) throw Object.assign(new Error("Ungültige Sitzung."), { statusCode: 401 });
  return user.sub;
};

export async function classSelectionRoutes(server: FastifyInstance, options: { service?: ClassSelectionService } = {}): Promise<void> {
  const service = options.service ?? classSelectionService;
  const auth = { onRequest: [server.authenticate] };
  server.get("/", auth, async (request) => service.getState(accountId(request.user)));
  server.post("/select", auth, async (request) => {
    const body = SelectClassRequestSchema.parse(request.body);
    return service.select(accountId(request.user), body.class);
  });
  server.post("/confirm", auth, async (request) => {
    const body = ConfirmClassRequestSchema.parse(request.body);
    return service.confirm(accountId(request.user), body.class);
  });
  server.post("/preflight", auth, async (request) => service.completePreflight(accountId(request.user)));
  server.post("/gm-override", auth, async (request) => {
    if (request.user.role !== "GM" && request.user.role !== "ADMIN") {
      throw Object.assign(new Error("Nur die Spielleitung darf Klassenzuweisungen korrigieren."), { statusCode: 403 });
    }
    const body = GMClassOverrideRequestSchema.parse(request.body);
    return service.override(accountId(request.user), body.playerId, body.class, body.reason);
  });
}
