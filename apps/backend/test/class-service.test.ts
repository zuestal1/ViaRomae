import test from "node:test";
import assert from "node:assert/strict";
import type { SelectablePlayerClass } from "@jlw/contracts";
import { ClassSelectionService, type ClassSelectionPlayer, type ClassSelectionRepository, type ClassSelectionUpdate } from "../src/modules/player/class-selection.service.js";

class MemoryRepository implements ClassSelectionRepository {
  players = new Map<string, ClassSelectionPlayer>([
    ["p1", { id: "p1", accountId: "a1", teamId: "t", class: null, classConfirmed: false, classSelectedAt: null, classConfirmedAt: null, classAssignedBy: null, preflightCompletedAt: null }],
    ["p2", { id: "p2", accountId: "a2", teamId: "t", class: "cleric", classConfirmed: true, classSelectedAt: new Date(), classConfirmedAt: new Date(), classAssignedBy: "a2", preflightCompletedAt: null }],
  ]);
  weapons: Array<{ playerId: string; definitionId: string }> = [];
  audits: Parameters<ClassSelectionRepository["appendOverrideAudit"]>[0][] = [];
  locks: string[] = [];
  failWithUniqueViolation = false;

  async transaction<T>(work: (repository: ClassSelectionRepository) => Promise<T>) { return work(this); }
  async findByAccount(accountId: string) { return [...this.players.values()].find((player) => player.accountId === accountId); }
  async findById(playerId: string) { return this.players.get(playerId); }
  async confirmedPlayers(teamId: string) { return [...this.players.values()].filter((player) => player.teamId === teamId && player.classConfirmed).map(({ id, class: playerClass }) => ({ id, class: playerClass })); }
  async lockTeam(teamId: string) { this.locks.push(teamId); }
  async updatePlayer(playerId: string, update: ClassSelectionUpdate) {
    if (this.failWithUniqueViolation) throw Object.assign(new Error("unique"), { code: "23505" });
    this.players.set(playerId, { ...this.players.get(playerId)!, ...update });
  }
  async grantStarterWeapon(playerId: string, definitionId: string) {
    if (!this.weapons.some((weapon) => weapon.playerId === playerId && weapon.definitionId === definitionId)) this.weapons.push({ playerId, definitionId });
  }
  async appendOverrideAudit(input: Parameters<ClassSelectionRepository["appendOverrideAudit"]>[0]) { this.audits.push(input); }
}

const fixture = () => { const repository = new MemoryRepository(); return { repository, service: new ClassSelectionService(repository) }; };

test("registered selection flow keeps selection tentative until confirmation", async () => {
  const { repository, service } = fixture();
  const selected = await service.select("a1", "guard");
  assert.equal(selected.confirmed, false);
  assert.equal(repository.players.get("p1")?.class, "guard");
  assert.deepEqual(repository.weapons, []);

  const confirmed = await service.confirm("a1", "guard");
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(repository.locks, ["t"]);
  assert.deepEqual(repository.weapons, [{ playerId: "p1", definitionId: "starter_halberd" }]);
  await service.confirm("a1", "guard");
  assert.equal(repository.weapons.length, 1, "idempotent confirmation must not duplicate the starter weapon");
  await assert.rejects(() => service.select("a1", "sculptor"), (error: any) => error.statusCode === 409);
});

test("confirmation rejects an occupied class and maps index races to conflict", async () => {
  const { repository, service } = fixture();
  await assert.rejects(() => service.confirm("a1", "cleric"), (error: any) => error.statusCode === 409);
  repository.failWithUniqueViolation = true;
  await assert.rejects(() => service.confirm("a1", "guard"), (error: any) => error.statusCode === 409);
});

test("GM override grants the class weapon and writes auditEvents through the same transaction", async () => {
  const { repository, service } = fixture();
  await assert.rejects(() => service.override("gm", "p2", "condottiere", " "), (error: any) => error.statusCode === 400);
  await service.override("gm", "p2", "condottiere", "Fehlzuweisung");
  assert.equal(repository.players.get("p2")?.class, "condottiere");
  assert.deepEqual(repository.weapons, [{ playerId: "p2", definitionId: "starter_side_sword" }]);
  assert.deepEqual(repository.audits, [{ actorId: "gm", playerId: "p2", teamId: "t", previousClass: "cleric" as SelectablePlayerClass, newClass: "condottiere", reason: "Fehlzuweisung" }]);
});
