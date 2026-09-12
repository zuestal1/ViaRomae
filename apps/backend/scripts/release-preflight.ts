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
    ["veröffentlichte Stores", await scalar(sql`SELECT COUNT(*) count FROM world_object WHERE type='STORE' AND publishable=true AND content_status='APPROVED'`), 5],
    ["Stores ohne Sortiment", await scalar(sql`SELECT COUNT(*) count FROM world_object wo WHERE wo.type='STORE' AND wo.publishable=true AND wo.content_status='APPROVED' AND NOT EXISTS (SELECT 1 FROM store_catalog_item sci WHERE sci.store_id=wo.id)`), 0],
    ["Storeartikel ohne Item-Definition", await scalar(sql`SELECT COUNT(*) count FROM store_catalog_item sci LEFT JOIN item_def d ON d.key=sci.definition_id WHERE d.id IS NULL`), 0],
    ["Spieleraccounts", await scalar(sql`SELECT COUNT(*) count FROM player`), expectedPlayers],
    ["Teams", await scalar(sql`SELECT COUNT(*) count FROM team`), expectedTeams],
    ["GM-/Admin-Konten", await scalar(sql`SELECT COUNT(*) count FROM account WHERE role IN ('GM','ADMIN')`), 1],
    ["Spieler ohne Team", await scalar(sql`SELECT COUNT(*) count FROM player p LEFT JOIN team t ON t.id=p.team_id WHERE t.id IS NULL`), 0],
  ] as const;
  let failed = false;
  for (const [label, actual, expected] of checks) {
    const minimum = label === "GM-/Admin-Konten" || label === "veröffentlichte Stores";
    const valid = minimum ? actual >= expected : actual === expected;
    console.log(`${valid ? "✓" : "✗"} ${label}: ${actual} (erwartet ${minimum ? "mindestens " : ""}${expected})`);
    failed ||= !valid;
  }
  if (failed) throw new Error("Release-Preflight fehlgeschlagen. Das Event darf nicht gestartet werden.");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
