import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

const expectedPlayers = Number(process.env["EXPECTED_PLAYER_COUNT"] ?? 13);
const expectedTeams = Number(process.env["EXPECTED_TEAM_COUNT"] ?? 4);

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  return Number((result.rows[0] as { count: string | number } | undefined)?.count ?? 0);
}

async function main() {
  const checks = [
    ["veröffentlichte Quests", await scalar(sql`SELECT COUNT(*) count FROM quest_definition`), 40],
    ["Quests ohne Schritte", await scalar(sql`SELECT COUNT(*) count FROM quest_definition q WHERE NOT EXISTS (SELECT 1 FROM quest_step s WHERE s.quest_definition_id=q.id)`), 0],
    ["Quests ohne Station", await scalar(sql`SELECT COUNT(*) count FROM quest_definition q WHERE NOT EXISTS (SELECT 1 FROM quest_station s WHERE s.quest_definition_id=q.id)`), 0],
    ["Spieleraccounts", await scalar(sql`SELECT COUNT(*) count FROM player`), expectedPlayers],
    ["Teams", await scalar(sql`SELECT COUNT(*) count FROM team`), expectedTeams],
    ["GM-/Admin-Konten", await scalar(sql`SELECT COUNT(*) count FROM account WHERE role IN ('GM','ADMIN')`), 1],
    ["Spieler ohne Team", await scalar(sql`SELECT COUNT(*) count FROM player p LEFT JOIN team t ON t.id=p.team_id WHERE t.id IS NULL`), 0],
  ] as const;
  let failed = false;
  for (const [label, actual, expected] of checks) {
    const valid = label === "GM-/Admin-Konten" ? actual >= expected : actual === expected;
    console.log(`${valid ? "✓" : "✗"} ${label}: ${actual} (erwartet ${label === "GM-/Admin-Konten" ? "mindestens " : ""}${expected})`);
    failed ||= !valid;
  }
  if (failed) throw new Error("Release-Preflight fehlgeschlagen. Das Event darf nicht gestartet werden.");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
