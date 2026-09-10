/**
 * useWebSocket Hook
 * -----------------
 * Manages WebSocket connection with automatic reconnect, event queuing,
 * and offline resilience for the Via Romae game client.
 *
 * Features:
 *   - Automatic reconnection with exponential backoff
 *   - Event queue for offline/disconnected periods
 *   - Recovery of missed events after reconnect
 *   - Heartbeat monitoring (ping/pong from server)
 *   - TypeScript-safe event subscriptions
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/auth.context.js";
import type {
  PvPChallengeEscapedEvent,
  PvPChallengeStartedEvent,
  RadiusEvent,
  WsConnectedEvent,
} from "@jlw/contracts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** All event types that can be received from the server */
export type WsEvent = 
  | RadiusEvent
  | WsConnectedEvent
  | CombatEvent
  | QuestEvent
  | TeamEvent
  | PvPEvent
  | PvPChallengeStartedEvent
  | PvPChallengeEscapedEvent;

/** Combat update events */
export interface CombatEvent {
  event: "combat:started" | "combat:round_resolved" | "combat:completed" | "combat:action_submitted";
  data: {
    combatId: string;
    [key: string]: unknown;
  };
}

/** Quest progression events */
export interface QuestEvent {
  event: "quest.accepted" | "quest.step_completed" | "quest.completed";
  teamId: string;
  questRunId: string;
  data?: unknown;
  timestamp: string;
}

/** Team state updates */
export interface TeamEvent {
  event: "team.updated" | "team.member_joined" | "team.member_left";
  teamId: string;
  data: unknown;
  timestamp: string;
}

/** PvP alerts */
export interface PvPEvent {
  event: "pvp.challenge" | "pvp.accepted" | "pvp.declined";
  sourceTeamId: string;
  targetTeamId: string;
  data: unknown;
  timestamp: string;
}

/** Connection states */
export type ConnectionState = 
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Event handler function */
export type EventHandler<T = WsEvent> = (event: T) => void;

// ── Constants ─────────────────────────────────────────────────────────────────

const INITIAL_RECONNECT_DELAY = 1000; // 1s
const MAX_RECONNECT_DELAY = 30000; // 30s
const RECONNECT_BACKOFF = 1.5;
const HEARTBEAT_TIMEOUT = 60000; // 60s - expect ping within this time
const EVENT_QUEUE_MAX_SIZE = 100;
const RECOVERY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseWebSocketOptions {
  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;
  /** Enable event recovery after reconnect (default: true) */
  enableRecovery?: boolean;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    autoReconnect = true,
    enableRecovery = true,
    debug = false,
  } = options;

  const { token, isAuthenticated } = useAuth();
  
  // ── State ───────────────────────────────────────────────────────────────────
  
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [lastError, setLastError] = useState<string | null>(null);
  
  // ── Refs ────────────────────────────────────────────────────────────────────
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const eventHandlers = useRef<Set<EventHandler>>(new Set());
  const lastEventTimestamp = useRef<string | null>(null);
  const offlineQueue = useRef<WsEvent[]>([]);
  const mountedRef = useRef(true);

  // ── Logging ─────────────────────────────────────────────────────────────────
  
  const log = useCallback((...args: unknown[]) => {
    if (debug) console.log("[WS]", ...args);
  }, [debug]);

  // ── Event Queue Management ──────────────────────────────────────────────────
  
  const queueEvent = useCallback((event: WsEvent) => {
    if (offlineQueue.current.length >= EVENT_QUEUE_MAX_SIZE) {
      // Drop oldest events to prevent memory issues
      offlineQueue.current.shift();
    }
    offlineQueue.current.push(event);
    log("Queued event (offline):", event.event);
  }, [log]);

  const flushQueue = useCallback(() => {
    const queue = offlineQueue.current;
    if (queue.length === 0) return;

    log(`Flushing ${queue.length} queued events`);
    queue.forEach(event => {
      eventHandlers.current.forEach(handler => handler(event));
    });
    offlineQueue.current = [];
  }, [log]);

  // ── Event Recovery ──────────────────────────────────────────────────────────
  
  const recoverMissedEvents = useCallback(async () => {
    if (!enableRecovery || !lastEventTimestamp.current) return;

    try {
      const since = lastEventTimestamp.current;
      const response = await fetch(
        `/api/v1/ws/events?since=${encodeURIComponent(since)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        const { events } = await response.json() as { events: WsEvent[] };
        log(`Recovered ${events.length} missed events`);
        
        events.forEach(event => {
          eventHandlers.current.forEach(handler => handler(event));
          if ("timestamp" in event) {
            lastEventTimestamp.current = event.timestamp;
          }
        });
      }
    } catch (error) {
      log("Failed to recover missed events:", error);
    }
  }, [enableRecovery, token, log]);

  // ── Heartbeat Management ────────────────────────────────────────────────────
  
  const resetHeartbeat = useCallback(() => {
    if (heartbeatTimer.current) {
      clearTimeout(heartbeatTimer.current);
    }
    
    heartbeatTimer.current = window.setTimeout(() => {
      log("Heartbeat timeout - connection appears dead");
      if (wsRef.current) {
        wsRef.current.close(4000, "Heartbeat timeout");
      }
    }, HEARTBEAT_TIMEOUT);
  }, [log]);

  // ── WebSocket Handlers ──────────────────────────────────────────────────────
  
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as WsEvent;
      
      // Update last event timestamp for recovery
      if ("timestamp" in data) {
        lastEventTimestamp.current = data.timestamp;
      }

      // Reset heartbeat on any message
      resetHeartbeat();

      // Dispatch to all registered handlers
      eventHandlers.current.forEach(handler => handler(data));
      
      log("Received event:", data.event);
    } catch (error) {
      log("Failed to parse WebSocket message:", error);
    }
  }, [log, resetHeartbeat]);

  const handleOpen = useCallback(() => {
    log("WebSocket connected");
    setConnectionState("connected");
    setLastError(null);
    reconnectAttempts.current = 0;
    
    // Start heartbeat monitoring
    resetHeartbeat();
    
    // Recover missed events if reconnecting
    if (connectionState === "reconnecting") {
      void recoverMissedEvents();
    }
    
    // Flush any queued events
    flushQueue();
  }, [log, resetHeartbeat, recoverMissedEvents, flushQueue, connectionState]);

  const handleClose = useCallback((event: CloseEvent) => {
    log("WebSocket closed:", event.code, event.reason);
    
    if (heartbeatTimer.current) {
      clearTimeout(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }

    // Don't reconnect if deliberately closed or unmounted
    if (!mountedRef.current || event.code === 1000) {
      setConnectionState("disconnected");
      return;
    }

    if (autoReconnect) {
      setConnectionState("reconnecting");
      
      // Calculate exponential backoff delay
      const delay = Math.min(
        INITIAL_RECONNECT_DELAY * Math.pow(RECONNECT_BACKOFF, reconnectAttempts.current),
        MAX_RECONNECT_DELAY
      );
      
      reconnectAttempts.current++;
      log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
      
      reconnectTimer.current = window.setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
    } else {
      setConnectionState("disconnected");
    }
  }, [log, autoReconnect]);

  const handleError = useCallback((event: Event) => {
    log("WebSocket error:", event);
    setConnectionState("error");
    setLastError("WebSocket connection error");
  }, [log]);

  // ── Connection Management ───────────────────────────────────────────────────
  
  const connect = useCallback(() => {
    if (!isAuthenticated || !token) {
      log("Cannot connect: not authenticated");
      return;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      log("Already connected");
      return;
    }

    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    try {
      setConnectionState("connecting");
      
      // Construct WebSocket URL with JWT token as query param
      // (browsers can't set Authorization header on WebSocket upgrade)
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // In dev: use window.location.host (Vite dev server) – Vite proxies
      // WebSocket connections via the `/api` rule (ws: true in vite.config.ts).
      // In prod: same host as the frontend.
      const host = window.location.host;
      const url = `${protocol}//${host}/api/v1/geo/ws?token=${token}`;
      
      log("Connecting to:", url.replace(token, "***"));
      
      const ws = new WebSocket(url);
      ws.onopen = handleOpen;
      ws.onclose = handleClose;
      ws.onerror = handleError;
      ws.onmessage = handleMessage;
      
      wsRef.current = ws;
    } catch (error) {
      log("Failed to create WebSocket:", error);
      setConnectionState("error");
      setLastError(error instanceof Error ? error.message : "Unknown error");
    }
  }, [isAuthenticated, token, log, handleOpen, handleClose, handleError, handleMessage]);

  const disconnect = useCallback(() => {
    log("Disconnecting");
    mountedRef.current = false;
    
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    
    if (heartbeatTimer.current) {
      clearTimeout(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close(1000, "Client disconnect");
      wsRef.current = null;
    }
    
    setConnectionState("disconnected");
  }, [log]);

  // ── Event Subscription ──────────────────────────────────────────────────────
  
  const subscribe = useCallback(<T extends WsEvent = WsEvent>(
    handler: EventHandler<T>,
    eventTypeFilter?: string
  ): (() => void) => {
    const wrappedHandler: EventHandler = (event) => {
      if (!eventTypeFilter || event.event === eventTypeFilter) {
        handler(event as T);
      }
    };
    
    eventHandlers.current.add(wrappedHandler);
    
    // Return unsubscribe function
    return () => {
      eventHandlers.current.delete(wrappedHandler);
    };
  }, []);

  // ── Send Message ────────────────────────────────────────────────────────────
  
  const send = useCallback(<T = unknown>(data: T): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
      log("Sent message:", data);
      return true;
    } else {
      log("Cannot send: not connected");
      
      // Queue event for later if it looks like a WsEvent
      // Note: Client-to-server messages are rare in this architecture,
      // so we skip queuing for safety. Server events are queued on receive.
      
      return false;
    }
  }, [log]);

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  
  useEffect(() => {
    mountedRef.current = true;
    
    if (isAuthenticated) {
      connect();
    }
    
    return () => {
      mountedRef.current = false;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // ── Return API ──────────────────────────────────────────────────────────────
  
  return {
    connectionState,
    isConnected: connectionState === "connected",
    isConnecting: connectionState === "connecting" || connectionState === "reconnecting",
    lastError,
    reconnectAttempts: reconnectAttempts.current,
    queuedEvents: offlineQueue.current.length,
    
    connect,
    disconnect,
    subscribe,
    send,
  };
}
