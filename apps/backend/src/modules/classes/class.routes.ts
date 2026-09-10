import type { FastifyInstance } from "fastify";
import { CLASSES, SLOTS } from "./class-rules.js";

/** Authoritative data endpoint; clients never hard-code ability numbers. */
export async function classRoutes(server: FastifyInstance): Promise<void> {
  server.get("/", async () => Object.values(CLASSES).map(definition => ({
    ...definition, slots: SLOTS,
    abilities: definition.abilities.map(ability => ({ ...ability, description: ability.name, disabledReason: null })),
  })));
}
