/**
 * useWorldObjects
 * ---------------
 * Keeps a live list of WorldObjects within the player's discovery radius
 * (≤ 55 m by default, as set by discovery_radius_m on the world_object row).
 *
 * Data sources (two-layered):
 *  1. **REST polling** – GET /api/v1/geo/world-objects is called whenever the
 *     rounded player tile changes (≈ every 10–30 m of movement) and at a
 *     minimum every 30 s via TanStack Query `refetchInterval`.
 *  2. **WebSocket (real-time)** – The /api/v1/geo/ws endpoint pushes
 *     `ws.connected` (initial snapshot) and `radius.transition` events.
 *     Incoming events immediately update the in-memory zone of individual
 *     objects so the HUD reacts without waiting for the next REST poll.
 *
 * OUTSIDE zone objects are removed from the returned list (no visible marker
 * needed). All other zones are kept with their most recently known zone value.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getApiBaseUrl } from "../lib/api.js";
import type {
  WorldObjectNearby,
  WorldObjectsResponse,
  WsConnectedEvent,
  RadiusEvent,
} from "@jlw/contracts";
import type { GeoPosition } from "./use-geolocation.js";
import { isQuestEvent, handleQuestWsEvent } from "./use-quests.js";

// ── Config ────────────────────────────────────────────────────────────────────

/** How often (ms) to re-poll the REST endpoint as a WS fallback. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Spatial tile size (degrees) used to derive the React Query cache key.
 * At the equator, 0.001° ≈ 111 m, so we re-fetch when the player crosses a
 * ~100 m grid cell.
 */
const TILE_PRECISION = 3; // decimal places → ~111 m grid

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseWorldObjectsResult {
  /** WorldObjects currently within the player's discovery radius. */
  worldObjects: WorldObjectNearby[];
  /** True while the initial REST fetch has not yet returned. */
  isLoading: boolean;
  /** WS connection state for diagnostic UI. */
  wsStatus: "connecting" | "connected" | "disconnected";
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWorldObjects(
  token: string | null,
  position: GeoPosition | null,
): UseWorldObjectsResult {
  // ── 1. Local object map (id → WorldObjectNearby) ──────────────────────────
  const [objectMap, setObjectMap] = useState<Map<string, WorldObjectNearby>>(
    new Map(),
  );
  const [wsStatus, setWsStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");

  // ── Helper: merge an array of objects into the map ─────────────────────────
  const mergeObjects = useCallback((incoming: WorldObjectNearby[]) => {
    setObjectMap(() => {
      const next = new Map<string, WorldObjectNearby>();
      for (const obj of incoming) {
        if (obj.zone !== "OUTSIDE") {
          next.set(obj.id, obj);
        }
      }
      return next;
    });
  }, []);

  // ── 2. REST polling via TanStack Query ────────────────────────────────────
  /**
   * Cache key changes when the player's tile changes (≈ 100 m movement).
   * This means refetches are triggered by significant movement rather than
   * every small GPS jitter.
   */
  const tileKey = position
    ? [
        parseFloat(position.lat.toFixed(TILE_PRECISION)),
        parseFloat(position.lng.toFixed(TILE_PRECISION)),
      ]
    : null;

  const { data: restData, isLoading: restLoading } = useQuery({
    queryKey: ["world-objects", tileKey],
    queryFn: async () => {
      const acc = position?.accuracy ?? 15;
      const latParam = position ? `&lat=${position.lat}&lng=${position.lng}` : "";
      return api.get<WorldObjectsResponse>(
        `/geo/world-objects?accuracy=${Math.round(acc)}${latParam}`,
      );
    },
    enabled: !!token && !!position,
    staleTime: POLL_INTERVAL_MS,
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Sync REST result into local map (only when WS has NOT yet bootstrapped)
  const wsBootstrapped = useRef(false);
  useEffect(() => {
    if (restData?.objects && !wsBootstrapped.current) {
      mergeObjects(restData.objects);
    }
  }, [restData, mergeObjects]);

  // ── 3. WebSocket for real-time zone updates ────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const encodedToken = encodeURIComponent(token);

    function connect() {
      if (cancelled) return;

      const url = `${getApiBaseUrl("websocket")}/geo/ws?token=${encodedToken}`;

      setWsStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        setWsStatus("connected");
      };

      ws.onmessage = (evt) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(evt.data as string) as
            | WsConnectedEvent
            | RadiusEvent
            | { event: string };

          if (msg.event === "ws.connected") {
            const connected = msg as WsConnectedEvent;
            wsBootstrapped.current = true;
            // Full snapshot – replace the map
            mergeObjects(connected.nearbyObjects);

          } else if (msg.event === "radius.transition") {
            const trans = msg as RadiusEvent;
            setObjectMap((prev) => {
              const next = new Map(prev);
              const existing = next.get(trans.worldObjectId);

              if (trans.newZone === "OUTSIDE") {
                // Object moved out of discovery range → remove marker
                next.delete(trans.worldObjectId);
              } else if (existing) {
                // Update zone of a known object
                next.set(trans.worldObjectId, {
                  ...existing,
                  zone: trans.newZone,
                  effectiveDistanceM: Math.max(0, trans.effectiveDistanceM),
                });
              }
              // If the object is not in our map yet (newly discovered edge case),
              // the next REST poll will pick it up.
              return next;
            });

          } else if (isQuestEvent(msg as { event: string })) {
            // Forward quest WS events to the quest query cache
            handleQuestWsEvent(
              msg as Parameters<typeof handleQuestWsEvent>[0],
              queryClient,
            );
          }
        } catch {
          // Non-JSON frame – ignore
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsStatus("disconnected");
        wsBootstrapped.current = false;
        // Reconnect after 5 s
        reconnectTimer.current = setTimeout(connect, 5_000);
      };

      ws.onerror = () => {
        ws.close(); // triggers onclose → reconnect
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      wsBootstrapped.current = false;
      setWsStatus("disconnected");
    };
  }, [token, mergeObjects]);

  // ── Output ────────────────────────────────────────────────────────────────
  return {
    worldObjects: Array.from(objectMap.values()),
    isLoading: restLoading && objectMap.size === 0,
    wsStatus,
  };
}
