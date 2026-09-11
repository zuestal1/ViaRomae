/**
 * Auth Service
 * ------------
 * Handles access-code verification, session persistence, and the /me query.
 *
 * Hashing strategy: Node.js built-in `crypto.scrypt` – no extra dependencies.
 * Hash storage format: `scrypt:<saltHex>:<keyHex>`
 */

import crypto from "node:crypto";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { accounts, sessions } from "../../db/schema/account.js";
import { players, teams } from "../../db/schema/player.js";
import { type MeResponse, type PlayerClass } from "@jlw/contracts";
import { getTeamBalance } from "../economy/ledger.service.js";
import { itemDefs, itemInstances } from "../../db/schema/economy_v2.js";
import { abilitiesForClass, CLASSES } from "../classes/class-rules.js";
import { getPlayerStats } from "../player/player-stats.service.js";

const CLASS_ICONS: Record<PlayerClass, string> = {
  guard: "🛡️", cleric: "🙏", sculptor: "🗿", condottiere: "⚔️",
};

const scryptAsync = promisify<
  crypto.BinaryLike,
  crypto.BinaryLike,
  number,
  crypto.ScryptOptions,
  Buffer
>(crypto.scrypt);

// ── Scrypt parameters (OWASP recommended minimum) ────────────────────────────
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SCRYPT_OPTS: crypto.ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Hash an access code for storage.
 * Returns a string of the form `scrypt:<saltHex>:<keyHex>`.
 */
export async function hashAccessCode(code: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(code, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

/**
 * Timing-safe verification of a plain-text access code against a stored hash.
 * Returns `false` for any malformed hash to prevent information leakage.
 */
export async function verifyAccessCode(
  code: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [, saltHex, keyHex] = parts as [string, string, string];
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scryptAsync(code, salt, KEY_LEN, SCRYPT_OPTS);
    // timingSafeEqual prevents timing attacks even if lengths differ
    return expected.length === actual.length
      ? crypto.timingSafeEqual(actual, expected)
      : false;
  } catch {
    // Malformed hex or other unexpected error → treat as invalid
    return false;
  }
}

// ── Account lookup ────────────────────────────────────────────────────────────

/**
 * Scan all accounts and find the one whose accessCodeHash matches the
 * supplied plain-text code. Returns `null` if not found.
 *
 * NOTE: For ~13 players this full-scan is perfectly acceptable.
 *       A future migration can add an index on a deterministic code prefix
 *       if the user base grows.
 */
export async function findAccountByAccessCode(
  accessCode: string,
): Promise<(typeof accounts.$inferSelect) | null> {
  const all = await db.select().from(accounts);

  for (const account of all) {
    const valid = await verifyAccessCode(accessCode, account.accessCodeHash);
    if (valid) return account;
  }

  return null;
}

// ── Session management ────────────────────────────────────────────────────────

/** Persist a new session. The `token` field stores the signed JWT string. */
export async function createSession(opts: {
  accountId: string;
  token: string;
  deviceId?: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insert(sessions).values({
    accountId: opts.accountId,
    token: opts.token,
    deviceId: opts.deviceId ?? null,
    expiresAt,
  });
}

/**
 * Invalidate a session by its token (JWT string).
 * Safe to call even if the session does not exist (e.g. already expired).
 */
export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.token, token));
}

// ── /me aggregation ───────────────────────────────────────────────────────────

/**
 * Aggregates account + optional player + optional team into the MeResponse
 * shape used by both the lobby and the map header.
 */
export async function getMe(accountId: string): Promise<MeResponse> {
  // Fetch account
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId));

  if (!account) {
    const err = new Error("Account not found") as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }

  // Try to find a linked player record (GMs/admins may not have one)
  const [player] = await db
    .select()
    .from(players)
    .where(eq(players.accountId, accountId));

  if (!player) {
    return {
      account: { id: account.id, username: account.username, role: account.role },
      player: null,
    };
  }

  // Fetch the player's team
  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, player.teamId));

  const teamPlayers = team ? await db.select().from(players).where(eq(players.teamId, team.id)) : [];
  const accountIds = teamPlayers.map((member) => member.accountId);
  const teamAccounts = accountIds.length ? await db.select().from(accounts).where(inArray(accounts.id, accountIds)) : [];
  const accountNames = new Map(teamAccounts.map((entry) => [entry.id, entry.username]));
  const equipped = await db.select({ slot: itemInstances.slot, name: itemDefs.name })
    .from(itemInstances).leftJoin(itemDefs, eq(itemInstances.definitionId, itemDefs.key))
    .where(and(eq(itemInstances.ownerId, player.id), eq(itemInstances.isEquipped, true)));
  const stats = player.class ? await getPlayerStats(player) : { hpMax: 100, atk: 0, def: 0, initiative: 0 };
  const abilities = player.class ? abilitiesForClass(player.class) : [];
  const passive = abilities.find((ability) => ability.passive);

  return {
    account: { id: account.id, username: account.username, role: account.role },
    player: {
      id: player.id,
      class: player.class,
      classConfirmed: player.classConfirmed,
      preflightCompleted: player.preflightCompletedAt !== null,
      hpCurrent: player.hpCurrent,
      hpMax: stats.hpMax,
      icon: player.class ? CLASS_ICONS[player.class] : "❔",
      stats: { atk: stats.atk, def: stats.def, init: stats.initiative },
      passive: passive
        ? { name: passive.displayName, description: passive.description, icon: CLASS_ICONS[player.class!] }
        : { name: "Noch keine Klasse", description: "Wähle zuerst deine dauerhafte Rolle.", icon: "❔" },
      abilities,
      statusEffects: [],
      equipment: (["WEAPON", "CLOTHING", "DEFENSE", "ARTIFACT"] as const).map((slot) => ({
        slot, name: equipped.find((item) => item.slot === slot)?.name ?? null,
      })),
      status: player.status,
      team: team
        ? {
            id: team.id,
            name: team.name,
            inventoryCapacity: team.inventoryCapacity,
            fame: await getTeamBalance(team.id, "FAME"),
            denarii: await getTeamBalance(team.id, "DENARII"),
            members: teamPlayers.map((member) => ({
              id: member.id,
              name: member.playerName ?? accountNames.get(member.accountId) ?? "Unbekannt",
              class: member.class,
              classConfirmed: member.classConfirmed,
              preflightCompleted: member.preflightCompletedAt !== null,
              hpCurrent: member.hpCurrent,
              hpMax: member.class ? CLASSES[member.class].baseStats.maxHP : 100,
            })),
            highestFameTierReached: team.highestFameTierReached,
          }
        : null,
    },
  };
}
