import { db } from "../../db/client.js";
import { eventState } from "../../db/schema/media.js";

export type RuntimeEventState = {
  state: "NOT_STARTED" | "ACTIVE" | "PAUSED" | "ENDED";
  currentDay: 1 | 2;
  leaderboardFrozen: boolean;
};

export async function getRuntimeEventState(executor: any = db): Promise<RuntimeEventState> {
  const [row] = await executor.select().from(eventState).limit(1);
  if (!row) throw Object.assign(new Error("Event state not initialized."), { statusCode: 503 });
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
  return {
    state: row.state,
    currentDay: Number(metadata["currentDay"] ?? 1) >= 2 ? 2 : 1,
    leaderboardFrozen: row.leaderboardFrozen,
  };
}

export async function requireActiveEvent(executor: any = db): Promise<RuntimeEventState> {
  const runtime = await getRuntimeEventState(executor);
  if (runtime.state !== "ACTIVE") {
    throw Object.assign(new Error(runtime.state === "PAUSED"
      ? "Das Spiel ist vorübergehend pausiert."
      : runtime.state === "ENDED" ? "Der Spieltag ist beendet." : "Das Spiel wurde noch nicht gestartet."), { statusCode: 423 });
  }
  return runtime;
}

export function questBelongsToDay(day: string | null, currentDay: 1 | 2, type?: string): boolean {
  if (type === "LONG_TERM") return true;
  if (!day) return true;
  const normalized = day.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return currentDay === 1
    ? ["1", "D1", "DAY_1", "TAG_1"].includes(normalized)
    : ["2", "D2", "DAY_2", "TAG_2"].includes(normalized);
}
