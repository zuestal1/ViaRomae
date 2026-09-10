/**
 * Combat Hook (Epic 6 + Epic 7)
 * Manages combat state, WebSocket events, and API calls.
 * 
 * Epic 7 enhancements:
 *   - Real-time WebSocket integration for combat events
 *   - Automatic state sync when combat events are received
 *   - No polling – events are pushed from server
 */

import { useState, useEffect, useCallback } from "react";
import { useWsEvent } from "../contexts/websocket.context.js";
import { API_BASE } from "../lib/api.js";
import type {
  CombatInstance,
  CombatLog,
  ActionType,
  AbilityId,
  CombatStartedEvent,
  CombatRoundResolvedEvent,
  CombatCompletedEvent,
  PvPChallengeStartedEvent,
  PvPChallengeEscapedEvent,
} from "@jlw/contracts";

export type ActivePvPChallenge = PvPChallengeStartedEvent["data"];

export function useCombat(playerId: string, token?: string) {
  const [activeCombat, setActiveCombat] = useState<CombatInstance | null>(null);
  const [logs, setLogs] = useState<CombatLog[]>([]);
  const [activeChallenge, setActiveChallenge] =
    useState<ActivePvPChallenge | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch active combat for player's team
  const fetchActiveCombat = useCallback(async () => {
    if (!playerId || !token) return;

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/combat/team/active`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const combat: CombatInstance = await res.json();
        setActiveCombat(combat);
      } else if (res.status === 404) {
        setActiveCombat(null);
      } else {
        throw new Error("Failed to fetch active combat");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [playerId, token]);

  // Submit combat action
  const submitAction = useCallback(
    async (actionType: ActionType, targetId?: string, details?: { abilityId: string; targetIds: string[] }) => {
      if (!activeCombat || !token) return;

      // Generate UUID (browser-compatible)
      const idempotencyKey = window.crypto.randomUUID();

      try {
        const res = await fetch(
          `${API_BASE}/combat/${activeCombat.id}/action`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              ...(abilityId ? { abilityId } : { actionType }),
              targetId,
              ...details,
              idempotencyKey,
            }),
          }
        );

        if (!res.ok) {
          throw new Error("Failed to submit action");
        }

        // Refresh combat state
        await fetchActiveCombat();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeCombat, token, fetchActiveCombat]
  );

  // ── WebSocket Event Handlers (Epic 7) ──────────────────────────────────────

  // Combat Started: Fetch full combat state
  useWsEvent("combat:started", useCallback((event: CombatStartedEvent) => {
    console.log("[Combat] Combat started:", event);
    setActiveChallenge(null);
    setLogs([]);
    void fetchActiveCombat();
  }, [fetchActiveCombat]));

  useWsEvent<PvPChallengeStartedEvent>("pvp:challenge_started", useCallback((event: PvPChallengeStartedEvent) => {
    setActiveChallenge(event.data);
  }, []));

  useWsEvent<PvPChallengeEscapedEvent>("pvp:challenge_escaped", useCallback((event: PvPChallengeEscapedEvent) => {
    setActiveChallenge((current) =>
      current?.challengeId === event.data.challengeId ? null : current,
    );
  }, []));

  // Combat Round Resolved: Update logs and state
  useWsEvent("combat:round_resolved", useCallback((event: CombatRoundResolvedEvent) => {
    console.log("[Combat] Round resolved:", event);
    if (event.data.logs) {
      setLogs((prev) => [...prev, ...event.data.logs]);
    }
    void fetchActiveCombat();
  }, [fetchActiveCombat]));

  // Combat Completed: Update logs, refresh state, clear after delay
  useWsEvent("combat:completed", useCallback((event: CombatCompletedEvent) => {
    console.log("[Combat] Combat ended:", event);
    if (event.data.logs) {
      setLogs((prev) => [...prev, ...event.data.logs]);
    }
    void fetchActiveCombat();

    // Clear combat UI after 3 seconds
    setTimeout(() => {
      setActiveCombat(null);
      setLogs([]);
    }, 3000);
  }, [fetchActiveCombat]));

  // Initial fetch on mount
  useEffect(() => {
    if (token) {
      void fetchActiveCombat();
    }
  }, [token, fetchActiveCombat]);


  return {
    activeCombat,
    activeChallenge,
    logs,
    isLoading,
    error,
    submitAction,
    fetchActiveCombat,
  };
}
