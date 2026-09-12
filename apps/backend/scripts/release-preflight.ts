import { sql } from "drizzle-orm";
import pino from "pino";
import { db } from "../src/db/client.js";
import { S3Service } from "../src/modules/media/s3.service.js";

const expectedPlayers = Number(process.env["EXPECTED_PLAYER_COUNT"] ?? 13);
const expectedTeams = Number(process.env["EXPECTED_TEAM_COUNT"] ?? 4);
const expectedMediaSteps = [
  "M-D1-01-S06",
  "M-D1-02-S06",
  "M-D1-03-S06",
  "M-D2-01-S06",
  "M-D2-02-S06",
  "M-D2-03-S06",
] as const;

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query);
  return Number((result.rows[0] as { count: string | number } | undefined)?.count ?? 0);
}

async function storageSelfTest(stepId: string): Promise<void> {
  const storage = new S3Service(pino({ level: "warn" }));
  const body = Buffer.from(`Via Romae storage preflight: ${stepId}\n`, "utf8");
  const mimeType = "image/png";
  const signed = await storage.generatePresignedUploadUrl("release-preflight", stepId, mimeType, body.length);
  let uploaded = false;
  try {
    for (const origin of [process.env["FRONTEND_ORIGIN"], process.env["GM_FRONTEND_ORIGIN"]]) {
      if (!origin) throw new Error("FRONTEND_ORIGIN und GM_FRONTEND_ORIGIN müssen gesetzt sein");
      const corsResponse = await fetch(signed.uploadUrl, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      });
      const allowedOrigin = corsResponse.headers.get("access-control-allow-origin");
      const allowedMethods = corsResponse.headers.get("access-control-allow-methods") ?? "";
      const allowedHeaders = corsResponse.headers.get("access-control-allow-headers") ?? "";
      if (!corsResponse.ok || (allowedOrigin !== origin && allowedOrigin !== "*")
        || !allowedMethods.toUpperCase().split(/\s*,\s*/).includes("PUT")
        || !(allowedHeaders === "*" || allowedHeaders.toLowerCase().split(/\s*,\s*/).includes("content-type"))) {
        throw new Error(`CORS-Prüfung für ${origin} fehlgeschlagen`);
      }
    }
    const response = await fetch(signed.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType, origin: process.env["FRONTEND_ORIGIN"]! },
      body,
    });
    if (!response.ok) throw new Error(`signierter PUT antwortete mit HTTP ${response.status}`);
    uploaded = true;
    if (!await storage.validateObject(signed.objectKey, mimeType, body.length)) {
      throw new Error("HEAD-Prüfung von Typ und Größe fehlgeschlagen");
    }
  } finally {
    if (uploaded) await storage.deleteObject(signed.objectKey);
  }
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
  const mediaSteps = await db.execute(sql`
    SELECT step_id FROM quest_step
    WHERE step_action_type = 'UPLOAD_MEDIA'
    ORDER BY step_id
  `);
  const actualMediaSteps = (mediaSteps.rows as Array<{ step_id: string }>).map(({ step_id }) => step_id);
  const missingMediaSteps = expectedMediaSteps.filter((stepId) => !actualMediaSteps.includes(stepId));
  const unexpectedMediaSteps = actualMediaSteps.filter((stepId) => !expectedMediaSteps.includes(stepId as typeof expectedMediaSteps[number]));
  if (missingMediaSteps.length > 0 || unexpectedMediaSteps.length > 0) {
    console.log(`✗ UPLOAD_MEDIA-Schritte: fehlend [${missingMediaSteps.join(", ")}], unerwartet [${unexpectedMediaSteps.join(", ")}]`);
    failed = true;
  } else {
    for (const stepId of expectedMediaSteps) {
      try {
        await storageSelfTest(stepId);
        console.log(`✓ Storage CORS/PUT/HEAD/DELETE: ${stepId}`);
      } catch (error) {
        console.error(`✗ Storage CORS/PUT/HEAD/DELETE: ${stepId}`, error);
        failed = true;
      }
    }
  }
  if (failed) throw new Error("Release-Preflight fehlgeschlagen. Das Event darf nicht gestartet werden.");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
