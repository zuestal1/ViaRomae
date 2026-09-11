/**
 * useQuests / useAvailableQuests
 * ──────────────────────────────────────────────────────────────────────────────
 * TanStack Query hooks for the Epic 4 Quest Engine.
 *
 * Data strategy:
 *   • Active quest runs: polled every 15 s; invalidated via WS events.
 *   • Available quests:  polled every 10 s (depends on player position);
 *                        invalidated on quest.accepted events.
 *   • WS quest events (quest.accepted, quest.step_completed, quest.completed)
 *     are intercepted by extending the existing geo WebSocket connection.
 *     The hook accepts an optional `onQuestEvent` callback from the caller
 *     so the map screen can show toasts without a second WS connection.
 *
 * Mutations:
 *   useAcceptQuest()      → POST /api/v1/quests/accept
 *   useSubmitAnswer()     → POST /api/v1/quests/runs/:runId/steps/:stepId/answer
 *   useReachLocation()    → POST /api/v1/quests/runs/:runId/steps/:stepId/reach
 *   useCompleteQuest()    → POST /api/v1/quests/runs/:runId/complete
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ActiveQuestsResponse,
  AvailableQuestsResponse,
  CompleteQuestResponse,
  QuestEvent,
  QuestRunDetail,
  StepResult,
} from "@jlw/contracts";
import { api } from "../lib/api.js";

// ── Query keys ────────────────────────────────────────────────────────────────

export const QUEST_QUERY_KEYS = {
  active: ["quests", "active"] as const,
  available: ["quests", "available"] as const,
  run: (runId: string) => ["quests", "run", runId] as const,
};

// ── Active quest runs ─────────────────────────────────────────────────────────

export interface UseActiveQuestsResult {
  runs: QuestRunDetail[];
  isLoading: boolean;
  isError: boolean;
}

export function useActiveQuests(token: string | null): UseActiveQuestsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: QUEST_QUERY_KEYS.active,
    queryFn: () => api.get<ActiveQuestsResponse>("/quests"),
    enabled: !!token,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  return {
    runs: data?.runs ?? [],
    isLoading,
    isError,
  };
}

// ── Available (discoverable) quests ──────────────────────────────────────────

export interface UseAvailableQuestsResult {
  quests: AvailableQuestsResponse["quests"];
  isLoading: boolean;
}

export function useAvailableQuests(
  token: string | null,
): UseAvailableQuestsResult {
  const { data, isLoading } = useQuery({
    queryKey: QUEST_QUERY_KEYS.available,
    queryFn: () => api.get<AvailableQuestsResponse>("/quests/available"),
    enabled: !!token,
    staleTime: 8_000,
    refetchInterval: 10_000,
  });

  return {
    quests: data?.quests ?? [],
    isLoading,
  };
}

// ── Accept quest ──────────────────────────────────────────────────────────────

export function useAcceptQuest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questDefinitionId, dialogueOptionId }: { questDefinitionId: string; dialogueOptionId?: string }) =>
      api.post<{ run: QuestRunDetail; alreadyActive: boolean }>(
        "/quests/accept",
        { questDefinitionId, ...(dialogueOptionId ? { dialogueOptionId } : {}) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
      void queryClient.invalidateQueries({
        queryKey: QUEST_QUERY_KEYS.available,
      });
    },
  });
}

// ── Reach location ────────────────────────────────────────────────────────────

export interface ReachLocationVars {
  questRunId: string;
  stepId: string;
  lat: number;
  lng: number;
  accuracy: number;
}

export function useReachLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questRunId, stepId, lat, lng, accuracy }: ReachLocationVars) =>
      api.post<StepResult>(
        `/quests/runs/${questRunId}/steps/${stepId}/reach`,
        { lat, lng, accuracy },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
      void queryClient.invalidateQueries({
        queryKey: QUEST_QUERY_KEYS.run(variables.questRunId),
      });
    },
  });
}

// ── Submit answer ─────────────────────────────────────────────────────────────

export interface SubmitAnswerVars {
  questRunId: string;
  stepId: string;
  answer: string;
}

export function useSubmitAnswer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questRunId, stepId, answer }: SubmitAnswerVars) =>
      api.post<StepResult>(
        `/quests/runs/${questRunId}/steps/${stepId}/answer`,
        { answer, requireAllMembersOnline: true },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
      void queryClient.invalidateQueries({
        queryKey: QUEST_QUERY_KEYS.run(variables.questRunId),
      });
    },
  });
}

// ── Complete quest ────────────────────────────────────────────────────────────

export function useCompleteQuest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (questRunId: string) =>
      api.post<CompleteQuestResponse>(`/quests/runs/${questRunId}/complete`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
      void queryClient.invalidateQueries({
        queryKey: QUEST_QUERY_KEYS.available,
      });
      void queryClient.invalidateQueries({ queryKey: ["economy"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useDefeatEnemy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ questRunId, stepId }: { questRunId: string; stepId: string }) =>
      api.post<StepResult>(
        `/quests/runs/${questRunId}/steps/${stepId}/defeat`,
        {},
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
      void queryClient.invalidateQueries({
        queryKey: QUEST_QUERY_KEYS.run(variables.questRunId),
      });
      void queryClient.invalidateQueries({ queryKey: ["economy"] });
      void queryClient.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

// ── WS quest event handler (used by use-world-objects) ───────────────────────

/**
 * Returns true when the message is a quest-related WS event.
 * Used by useWorldObjects to detect and forward quest events.
 */
export function isQuestEvent(msg: { event: string }): msg is QuestEvent {
  return (
    msg.event === "quest.accepted" ||
    msg.event === "quest.step_completed" ||
    msg.event === "quest.completed"
  );
}

/**
 * Invalidates all quest queries when a quest WS event arrives.
 * Call this from the WS message handler in useWorldObjects.
 */
export function handleQuestWsEvent(
  event: QuestEvent,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  // Invalidate active runs so all screens re-fetch
  void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.active });
  void queryClient.invalidateQueries({ queryKey: QUEST_QUERY_KEYS.available });

  // For specific run updates
  if (
    event.event === "quest.step_completed" ||
    event.event === "quest.completed"
  ) {
    void queryClient.invalidateQueries({
      queryKey: QUEST_QUERY_KEYS.run(event.questRunId),
    });
  }
}
