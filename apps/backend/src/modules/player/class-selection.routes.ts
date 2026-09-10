import type { FastifyInstance } from "fastify";
import { ConfirmClassRequestSchema, GMClassOverrideRequestSchema, SelectClassRequestSchema } from "@jlw/contracts";
import { completePreflight, confirmClass, getClassSelectionState, overrideClass, selectClass } from "./class-selection.service.js";

const accountId = (user: { sub?: string }) => {
  if (!user.sub) throw Object.assign(new Error("Ungültige Sitzung."), { statusCode: 401 });
  return user.sub;
};

export async function classSelectionRoutes(server: FastifyInstance): Promise<void> {
  const auth = { onRequest: [server.authenticate] };
  server.get("/", auth, async (request) => getClassSelectionState(accountId(request.user)));
  server.post("/select", auth, async (request) => {
    const body = SelectClassRequestSchema.parse(request.body);
    return selectClass(accountId(request.user), body.class);
  });
  server.post("/confirm", auth, async (request) => {
    const body = ConfirmClassRequestSchema.parse(request.body);
    return confirmClass(accountId(request.user), body.class);
  });
  server.post("/preflight", auth, async (request) => completePreflight(accountId(request.user)));
  server.post("/gm-override", auth, async (request) => {
    if (request.user.role !== "GM" && request.user.role !== "ADMIN") {
      throw Object.assign(new Error("Nur die Spielleitung darf Klassenzuweisungen korrigieren."), { statusCode: 403 });
    }
    const body = GMClassOverrideRequestSchema.parse(request.body);
    return overrideClass(accountId(request.user), body.playerId, body.class, body.reason);
  });
}
