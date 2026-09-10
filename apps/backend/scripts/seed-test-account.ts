/**
 * seed-test-account.ts
 * --------------------
 * Legt zwei Test-Accounts + Teams + Spieler an (für lokalen Team-Handel).
 * Nur für lokale Entwicklung – niemals in Produktion verwenden!
 *
 * Ausführen:
 *   pnpm --filter @jlw/backend db:seed
 */

import { db } from "../src/db/client.js";
import { accounts, sessions } from "../src/db/schema/account.js";
import { teams, players } from "../src/db/schema/player.js";
import { hashAccessCode } from "../src/modules/auth/auth.service.js";
import { eq } from "drizzle-orm";
import { CLASSES } from "../src/modules/classes/class-rules.js";

const FIXTURES = [
  {
    accessCode: "test1234",
    username: "testuser",
    teamName: "Die Testgilde",
    class: "guard" as const,
    class: "swiss_guard" as const,
  },
  {
    accessCode: "test5678",
    username: "testuser2",
    teamName: "Die Rivalen",
    class: "CONDOTTIERE" as const,
  },
];

async function upsertFixture(opts: (typeof FIXTURES)[number]) {
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.username, opts.username));

  if (existing.length > 0 && existing[0]) {
    console.log(`♻️  ${opts.username} gefunden – wird neu angelegt...`);
    await db.delete(sessions).where(eq(sessions.accountId, existing[0].id));
    await db.delete(players).where(eq(players.accountId, existing[0].id));
    await db.delete(accounts).where(eq(accounts.id, existing[0].id));
  }

  const accessCodeHash = await hashAccessCode(opts.accessCode);

  const [account] = await db
    .insert(accounts)
    .values({
      username: opts.username,
      accessCodeHash,
      role: "PLAYER",
    })
    .returning();

  let team = (
    await db.select().from(teams).where(eq(teams.name, opts.teamName))
  )[0];

  if (!team) {
    [team] = await db
      .insert(teams)
      .values({ name: opts.teamName, inventoryCapacity: 40 })
      .returning();
    console.log(`✅ Team angelegt: ${opts.teamName}`);
  } else {
    console.log(`♻️  Team bereits vorhanden: ${opts.teamName}`);
  }

  await db.insert(players).values({
    accountId: account!.id,
    teamId: team!.id,
    class: opts.class,
    hpCurrent: CLASSES[opts.class].baseStats.maxHP,
    status: "ACTIVE",
  });

  console.log(`✅ Account ${opts.username} / Code ${opts.accessCode}\n`);
}

async function seed() {
  console.log("🌱 Starte Seeding (2 Test-Teams für Handel)...\n");

  for (const fixture of FIXTURES) {
    await upsertFixture(fixture);
  }

  console.log("━".repeat(50));
  console.log("🎮 Test-Zugangsdaten:");
  console.log("   Team A  Code test1234  User testuser   Team Die Testgilde");
  console.log("   Team B  Code test5678  User testuser2  Team Die Rivalen");
  console.log("━".repeat(50));
  console.log("\nHandel: beide in zwei Browsern/Inkognito einloggen,");
  console.log("Inventar öffnen → Tab Handel → anderes Team wählen.\n");

  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed fehlgeschlagen:", err);
  process.exit(1);
});
