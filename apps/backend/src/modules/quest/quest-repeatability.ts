export type RepeatabilityRun = {
  state: "ACTIVE" | "PENDING_REVIEW" | "COMPLETED" | "FAILED";
  startedAt: Date;
  completedAt: Date | null;
};

export type QuestAcceptanceDecision =
  | { allowed: true }
  | { allowed: false; reason: "ACTIVE" | "PENDING_REVIEW" | "NOT_REPEATABLE" | "COOLDOWN"; retryAt?: Date };

/**
 * The single repeatability policy shared by discovery and acceptance.
 * FAILED runs never prevent another attempt. An open run always prevents one.
 * A COMPLETED run requires explicit repeatability and an elapsed cooldown.
 */
export function decideQuestAcceptance(
  runs: readonly RepeatabilityRun[],
  definition: { repeatable: boolean; repeatCooldownSeconds: number | null },
  now = new Date(),
): QuestAcceptanceDecision {
  if (runs.some((run) => run.state === "ACTIVE")) return { allowed: false, reason: "ACTIVE" };
  if (runs.some((run) => run.state === "PENDING_REVIEW")) return { allowed: false, reason: "PENDING_REVIEW" };

  const completed = runs.filter((run) => run.state === "COMPLETED");
  if (completed.length === 0) return { allowed: true };
  if (!definition.repeatable) return { allowed: false, reason: "NOT_REPEATABLE" };

  const cooldownMs = (definition.repeatCooldownSeconds ?? 0) * 1_000;
  const latestCompletion = Math.max(...completed.map((run) => (run.completedAt ?? run.startedAt).getTime()));
  const retryAt = new Date(latestCompletion + cooldownMs);
  return retryAt.getTime() <= now.getTime()
    ? { allowed: true }
    : { allowed: false, reason: "COOLDOWN", retryAt };
}
