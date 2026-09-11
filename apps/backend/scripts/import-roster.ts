/**
 * Approved, idempotent production roster import.
 *
 * The plaintext access codes are read only from ROSTER_FILE. Their values are
 * never logged and only scrypt hashes are persisted. ROSTER_SHA256 makes the
 * reviewed file immutable between approval and deployment.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../src/db/client.js";
import { accounts } from "../src/db/schema/account.js";
import { players, teams } from "../src/db/schema/player.js";
import { hashAccessCode, verifyAccessCode } from "../src/modules/auth/auth.service.js";

const rosterSchema = z.object({
  version: z.literal(1),
  approvalId: z.string().trim().min(1).max(128),
  expectedPlayerCount: z.number().int().nonnegative(),
  expectedTeamCount: z.number().int().nonnegative(),
  teams: z.array(z.object({
    name: z.string().trim().min(1).max(64),
    inventoryCapacity: z.number().int().positive().default(40),
  }).strict()),
  accounts: z.array(z.discriminatedUnion("role", [
    z.object({ role: z.literal("PLAYER"), username: z.string().trim().min(1).max(64), accessCode: z.string().min(8).max(256), team: z.string().trim().min(1).max(64) }).strict(),
    z.object({ role: z.enum(["GM", "ADMIN"]), username: z.string().trim().min(1).max(64), accessCode: z.string().min(8).max(256) }).strict(),
  ])),
}).strict();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} muss gesetzt sein.`);
  return value;
}

async function main(): Promise<void> {
  const file = required("ROSTER_FILE");
  const expectedDigest = required("ROSTER_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("ROSTER_SHA256 ist kein SHA-256-Hash.");

  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new Error("ROSTER_FILE ist keine reguläre Datei.");
  if ((fileStat.mode & 0o077) !== 0) throw new Error("ROSTER_FILE muss private Dateirechte haben (chmod 600 oder restriktiver).");
  const raw = await readFile(file);
  const actualDigest = createHash("sha256").update(raw).digest("hex");
  if (!timingSafeEqual(Buffer.from(actualDigest), Buffer.from(expectedDigest))) {
    throw new Error("Roster-Prüfsumme stimmt nicht mit der Freigabe überein.");
  }

  let roster: z.infer<typeof rosterSchema>;
  try {
    roster = rosterSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new Error("Rosterdatei ist kein gültiges Roster-v1-Dokument.");
  }
  const playerAccounts = roster.accounts.filter((account) => account.role === "PLAYER");
  const configuredPlayers = Number(required("EXPECTED_PLAYER_COUNT"));
  const configuredTeams = Number(required("EXPECTED_TEAM_COUNT"));
  if (roster.expectedPlayerCount !== playerAccounts.length || roster.expectedTeamCount !== roster.teams.length ||
      configuredPlayers !== roster.expectedPlayerCount || configuredTeams !== roster.expectedTeamCount) {
    throw new Error("Rosterinhalt, freigegebene Sollzahlen und EXPECTED_* stimmen nicht überein.");
  }
  if (!roster.accounts.some((account) => account.role === "GM" || account.role === "ADMIN")) {
    throw new Error("Das Roster benötigt mindestens ein GM-/Admin-Konto.");
  }
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(roster.teams.map((team) => team.name)) || !unique(roster.accounts.map((account) => account.username))) {
    throw new Error("Teamnamen und Benutzernamen müssen innerhalb des Rosters eindeutig sein.");
  }
  const teamNames = new Set(roster.teams.map((team) => team.name));
  if (playerAccounts.some((account) => !teamNames.has(account.team))) throw new Error("Ein Spielerkonto verweist auf ein unbekanntes Team.");

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20260911)`);
    const teamIds = new Map<string, string>();
    for (const entry of roster.teams) {
      const [saved] = await tx.insert(teams).values({ name: entry.name, inventoryCapacity: entry.inventoryCapacity })
        .onConflictDoUpdate({ target: teams.name, set: { inventoryCapacity: entry.inventoryCapacity } }).returning({ id: teams.id });
      teamIds.set(entry.name, saved!.id);
    }
    for (const entry of roster.accounts) {
      const [existing] = await tx.select().from(accounts).where(eq(accounts.username, entry.username));
      if (existing && existing.role !== entry.role) throw new Error("Ein bestehendes Konto hat eine andere Rolle als im freigegebenen Roster.");
      const accessCodeHash = existing && await verifyAccessCode(entry.accessCode, existing.accessCodeHash)
        ? existing.accessCodeHash : await hashAccessCode(entry.accessCode);
      const [account] = await tx.insert(accounts).values({ username: entry.username, role: entry.role, accessCodeHash })
        .onConflictDoUpdate({ target: accounts.username, set: { accessCodeHash } }).returning({ id: accounts.id });
      if (entry.role === "PLAYER") {
        const teamId = teamIds.get(entry.team)!;
        const [existingPlayer] = await tx.select({ id: players.id }).from(players).where(eq(players.accountId, account!.id));
        if (existingPlayer) await tx.update(players).set({ teamId, playerName: entry.username }).where(eq(players.id, existingPlayer.id));
        else await tx.insert(players).values({ accountId: account!.id, teamId, playerName: entry.username });
      }
    }
  });
  console.log(`Roster ${roster.approvalId} importiert: ${roster.expectedPlayerCount} Spieler, ${roster.expectedTeamCount} Teams, ${roster.accounts.length - playerAccounts.length} GM/Admin.`);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Rosterimport fehlgeschlagen.");
  process.exit(1);
});
