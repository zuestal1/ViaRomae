/**
 * GameMap
 * -------
 * Renders the basemap (MapTiler / OSM) via react-map-gl (MapLibre GL JS)
 * and shows:
 *   • The current player position as a pulsing marker.
 *   • WorldObject markers for all objects within discovery_radius_m (≤ 55 m).
 *   • Day-boundary PlayArea polygons as semi-transparent overlays.
 *   • Quest HUD (Epic 4): active quest slots at the bottom.
 *   • Quest Bottom-Sheet: opens on HUD slot click or DIALOGUE-phase tap.
 *
 * The map style URL is configured via VITE_MAPTILER_API_KEY.
 * If the key is missing a MapLibre demo style is used as fallback.
 *
 * GPS position is continuously tracked via `useGeolocation` which also
 * rate-limits server updates (every 30 s).
 *
 * WorldObjects are kept in sync via `useWorldObjects` (REST + WebSocket).
 * PlayArea polygons are fetched once on mount and cached for 5 min.
 *
 * Quest data (Epic 4):
 *   Active runs and available quests are fetched via useActiveQuests /
 *   useAvailableQuests (TanStack Query + WS invalidation).
 */

import { useCallback, useRef, useState } from "react";
import Map, {
  type MapRef,
  Marker,
  NavigationControl,
  Source,
  Layer,
} from "react-map-gl/maplibre";
import type {
  FillLayerSpecification,
  LineLayerSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useQuery } from "@tanstack/react-query";

import { useGeolocation } from "../../hooks/use-geolocation.js";
import { useWorldObjects } from "../../hooks/use-world-objects.js";
import { useStateRecovery } from "../../hooks/use-state-recovery.js";
import { useAuth } from "../../contexts/auth.context.js";
import { api } from "../../lib/api.js";
import { WorldObjectMarker } from "./world-object-marker.js";
import type { PlayAreasResponse, QuestAvailable } from "@jlw/contracts";

// ── Quest imports (Epic 4) ─────────────────────────────────────────────────────
import {
  useActiveQuests,
  useAvailableQuests,
  useAcceptQuest,
  useSubmitAnswer,
  useReachLocation,
  useCompleteQuest,
  useDefeatEnemy,
} from "../../hooks/use-quests.js";
import { QuestHUD } from "../quest/quest-hud.js";
import { QuestBottomSheet } from "../quest/quest-bottom-sheet.js";
import { EconomySheet } from "../inventory/economy-sheet.js";
import { useEconomySummary, usePlayerInventory } from "../../hooks/use-economy.js";
import { useCombat } from "../../hooks/use-combat.js";
import { CombatScreen } from "../combat/combat-screen.js";
import { PvPChallengeWarning } from "../combat/pvp-challenge-warning.js";

// ── Map style ─────────────────────────────────────────────────────────────────

const MAPTILER_KEY = import.meta.env["VITE_MAPTILER_API_KEY"] as string | undefined;

/** MapTiler Streets (OSM data) or the public MapLibre demo style as fallback. */
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

// Default centre: Einsiedeln region (adjust to actual event location)
const DEFAULT_CENTER = { longitude: 8.749, latitude: 47.126 };
const DEFAULT_ZOOM = 15;

// ── PlayArea layer styles ─────────────────────────────────────────────────────

const PLAY_AREA_FILL_STYLE: Omit<FillLayerSpecification, "id" | "source"> = {
  type: "fill",
  paint: {
    "fill-color": "#cd7f32",
    "fill-opacity": 0.08,
  },
};

const PLAY_AREA_OUTLINE_STYLE: Omit<LineLayerSpecification, "id" | "source"> =
  {
    type: "line",
    paint: {
      "line-color": "#cd7f32",
      "line-width": 2,
      "line-opacity": 0.6,
      "line-dasharray": [4, 3],
    },
  };

// ── Props ─────────────────────────────────────────────────────────────────────

interface GameMapProps {
  /** Called when the user presses the back-to-lobby button. */
  onBack?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GameMap({ onBack }: GameMapProps) {
  const { profile, token } = useAuth();
  const playerId = profile?.player?.id ?? "";
  const { activeCombat, activeChallenge, logs, submitAction, submitRevive } = useCombat(
    playerId,
    token ?? undefined,
  );
  const combatInventory = usePlayerInventory(token);
  const { position, error: geoError, isReady } = useGeolocation();
  
  // ── State Recovery (Epic 7) ───────────────────────────────────────────────
  // Automatically recovers combat/quest state after reconnection
  useStateRecovery({
    debug: import.meta.env.DEV,
    onRecoveryComplete: () => {
      console.log("[GameMap] State recovery completed");
    },
  });

  // ── WorldObjects (nearby markers) ─────────────────────────────────────────
  const { worldObjects, wsStatus } = useWorldObjects(token, position);

  // ── PlayAreas (day-boundary polygons) ─────────────────────────────────────
  const { data: playAreaData } = useQuery({
    queryKey: ["play-areas"],
    queryFn: () => api.get<PlayAreasResponse>("/geo/play-areas"),
    enabled: !!token,
    staleTime: 5 * 60_000, // 5 minutes
  });

  // Build a GeoJSON FeatureCollection from all play areas that have geometry.
  const playAreaGeoJson: GeoJSON.FeatureCollection | null =
    (playAreaData?.areas ?? []).some((a) => a.geojson !== null)
      ? {
          type: "FeatureCollection",
          features: (playAreaData?.areas ?? [])
            .filter((a) => a.geojson !== null)
            .map((a) => ({
              type: "Feature" as const,
              properties: { day: a.day, name: a.name ?? `Tag ${a.day}` },
              geometry: a.geojson as GeoJSON.Geometry,
            })),
        }
      : null;

  // ── Quest data (Epic 4) ────────────────────────────────────────────────────
  const { runs: activeRuns } = useActiveQuests(token);
  const { quests: availableQuests } = useAvailableQuests(token);

  // Quest mutations
  const acceptQuestMutation = useAcceptQuest();
  const submitAnswerMutation = useSubmitAnswer();
  const reachLocationMutation = useReachLocation();
  const completeQuestMutation = useCompleteQuest();
  const defeatEnemyMutation = useDefeatEnemy();
  const { data: economy } = useEconomySummary(token);

  const [inventoryOpen, setInventoryOpen] = useState(false);

  // ── Quest UI state ─────────────────────────────────────────────────────────
  /** ID of the active QuestRun currently shown in the sheet. */
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  /** Available quest shown in the sheet (DISCOVER/DIALOGUE phase). */
  const [selectedAvailableQuest, setSelectedAvailableQuest] =
    useState<QuestAvailable | null>(null);

  const selectedRun =
    selectedRunId != null
      ? activeRuns.find((r) => r.id === selectedRunId) ?? null
      : null;

  const isSheetOpen = selectedRun != null || selectedAvailableQuest != null;

  function handleCloseSheet() {
    setSelectedRunId(null);
    setSelectedAvailableQuest(null);
  }

  function handleSelectRun(runId: string) {
    setSelectedAvailableQuest(null);
    setSelectedRunId(runId);
  }

  // Auto-open sheet when a DIALOGUE-phase quest is available and no sheet is open
  // (only open once – the user can dismiss it)
  const dialogueQuest = availableQuests.find(
    (q) => q.discoveryPhase === "DIALOGUE",
  );

  // ── Map pan/zoom helpers ───────────────────────────────────────────────────
  const mapRef = useRef<MapRef | null>(null);
  const [hasFollowedInitial, setHasFollowedInitial] = useState(false);

  /** Centre the map on the player's position once the first fix is acquired. */
  const handleMapLoad = useCallback(() => {
    if (position && !hasFollowedInitial) {
      mapRef.current?.flyTo({
        center: [position.lng, position.lat],
        zoom: DEFAULT_ZOOM,
        duration: 1200,
      });
      setHasFollowedInitial(true);
    }
  }, [position, hasFollowedInitial]);

  // Follow the player whenever a new position arrives (only if not yet followed)
  if (position && !hasFollowedInitial && mapRef.current) {
    mapRef.current.flyTo({
      center: [position.lng, position.lat],
      zoom: DEFAULT_ZOOM,
      duration: 800,
    });
    setHasFollowedInitial(true);
  }

  // ── Quest mutation callbacks ───────────────────────────────────────────────

  async function handleAcceptQuest(questDefinitionId: string) {
    await acceptQuestMutation.mutateAsync(questDefinitionId);
  }

  async function handleSubmitAnswer(
    questRunId: string,
    stepId: string,
    answer: string,
  ) {
    return submitAnswerMutation.mutateAsync({ questRunId, stepId, answer });
  }

  async function handleReachLocation(questRunId: string, stepId: string) {
    if (!position) throw new Error("GPS-Position nicht verfügbar.");
    return reachLocationMutation.mutateAsync({
      questRunId,
      stepId,
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracy,
    });
  }

  async function handleCompleteQuest(questRunId: string) {
    return completeQuestMutation.mutateAsync(questRunId);
  }

  async function handleDefeatEnemy(questRunId: string, stepId: string) {
    return defeatEnemyMutation.mutateAsync({ questRunId, stepId });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#1a1a2e]">

      {/* ── Map ─────────────────────────────────────────────────────────── */}
      <Map
        ref={mapRef}
        initialViewState={{
          ...DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
        }}
        style={{ width: "100%", height: "100%" }}
        mapStyle={MAP_STYLE}
        onLoad={handleMapLoad}
        bearing={0}
        attributionControl={false}
      >
        {/* Navigation controls (zoom +/-) */}
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* ── PlayArea polygons ─────────────────────────────────────────── */}
        {playAreaGeoJson && (
          <Source id="play-areas" type="geojson" data={playAreaGeoJson}>
            <Layer
              id="play-areas-fill"
              {...PLAY_AREA_FILL_STYLE}
              source="play-areas"
            />
            <Layer
              id="play-areas-outline"
              {...PLAY_AREA_OUTLINE_STYLE}
              source="play-areas"
            />
          </Source>
        )}

        {/* ── WorldObject markers ───────────────────────────────────────── */}
        {worldObjects.map((obj) => (
          <WorldObjectMarker key={obj.id} object={obj} />
        ))}

        {/* ── Quest waypoint markers (REACH_LOCATION targets) ───────────── */}
        {activeRuns
          .filter(
            (r) =>
              r.currentStep?.stepActionType === "REACH_LOCATION" &&
              r.currentStep.targetLat != null &&
              r.currentStep.targetLng != null,
          )
          .map((r) => (
            <Marker
              key={`quest-wp-${r.id}`}
              latitude={r.currentStep!.targetLat!}
              longitude={r.currentStep!.targetLng!}
              anchor="bottom"
            >
              <div className="flex flex-col items-center">
                <div className="rounded-full bg-[#cd7f32] border-2 border-white shadow-lg px-2 py-0.5 text-[10px] font-bold text-[#1a1a2e] whitespace-nowrap max-w-[120px] truncate">
                  🎯 {r.currentStep!.targetObjectName ?? "Ziel"}
                </div>
                <div className="w-0.5 h-2 bg-[#cd7f32]" />
                <div className="w-2 h-2 rounded-full bg-[#cd7f32] border border-white" />
              </div>
            </Marker>
          ))}

        {/* ── Player marker ─────────────────────────────────────────────── */}
        {position && (
          <Marker
            longitude={position.lng}
            latitude={position.lat}
            anchor="center"
          >
            <div className="relative flex items-center justify-center">
              <span className="absolute h-10 w-10 animate-ping rounded-full bg-[#cd7f32]/30" />
              <span className="absolute h-6 w-6 rounded-full bg-[#cd7f32]/20 ring-2 ring-[#cd7f32]/40" />
              <span className="relative h-3 w-3 rounded-full bg-[#cd7f32] ring-2 ring-white shadow-lg" />
            </div>
          </Marker>
        )}
      </Map>

      {/* ── HUD Overlays ────────────────────────────────────────────────── */}

      {/* Top bar */}
      <div
        className="pointer-events-none absolute left-0 right-0 top-0 z-10
                      flex items-center justify-between px-4 py-3
                      bg-gradient-to-b from-black/70 to-transparent"
      >
        {/* Back button */}
        {onBack && (
          <button
            onClick={onBack}
            className="pointer-events-auto rounded-full bg-black/50 px-4 py-1.5
                       text-xs font-semibold text-[#f4e4c1] backdrop-blur-sm
                       hover:bg-black/70 active:scale-95 transition"
          >
            ← Lobby
          </button>
        )}

        {/* Player name & team */}
        {profile?.player?.team && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setInventoryOpen(true)}
              className="pointer-events-auto rounded-full bg-black/50 px-3 py-1.5
                         text-[11px] font-semibold text-[#f4e4c1] backdrop-blur-sm
                         hover:bg-black/70 active:scale-95 transition"
            >
              🎒 {economy?.denarii ?? "—"}₫ · {economy?.fame ?? "—"}★
            </button>
            <div className="text-right">
            <p className="text-xs font-bold text-[#cd7f32] tracking-widest">
              {profile.player.team.name}
            </p>
            <p className="text-[10px] text-[#f4e4c1]/70">
              {profile.account.username}
            </p>
            </div>
          </div>
        )}
      </div>

      {/* DIALOGUE-phase quest badge (tap to open) */}
      {!isSheetOpen && dialogueQuest && (
        <div className="absolute top-14 left-0 right-0 z-10 flex justify-center px-4">
          <button
            onClick={() => setSelectedAvailableQuest(dialogueQuest)}
            className="flex items-center gap-2 rounded-full bg-[#cd7f32]/90 px-4 py-2
                       text-xs font-bold text-[#1a1a2e] shadow-lg
                       backdrop-blur-sm hover:bg-[#cd7f32] transition active:scale-95
                       animate-pulse"
          >
            💬 {dialogueQuest.title} – Quest annehmen?
          </button>
        </div>
      )}

      {/* Nearby objects counter */}
      {worldObjects.length > 0 && (
        <div className="absolute top-14 left-3 z-10">
          <div className="rounded-full bg-black/60 px-3 py-1 text-xs text-[#cd7f32] backdrop-blur-sm">
            {worldObjects.length} Objekt{worldObjects.length !== 1 ? "e" : ""}{" "}
            in Reichweite
          </div>
        </div>
      )}

      {/* GPS status badge */}
      <div className="absolute bottom-20 left-3 z-10 flex flex-col gap-1">
        {!isReady && !geoError && (
          <div className="rounded-full bg-black/60 px-3 py-1 text-xs text-[#cd7f32] backdrop-blur-sm animate-pulse">
            📡 GPS wird gesucht…
          </div>
        )}
        {geoError && (
          <div className="max-w-[200px] rounded-lg bg-red-900/80 px-3 py-2 text-xs text-red-200 backdrop-blur-sm">
            ⚠️ {geoError}
          </div>
        )}
        {isReady && position && (
          <div className="rounded-full bg-black/50 px-3 py-1 text-[10px] text-green-400 backdrop-blur-sm">
            📡 ±{Math.round(position.accuracy)} m
          </div>
        )}
        {wsStatus === "disconnected" && isReady && (
          <div className="rounded-full bg-yellow-900/60 px-3 py-1 text-[10px] text-yellow-400 backdrop-blur-sm">
            ⚡ Echtzeit getrennt…
          </div>
        )}
      </div>

      {/* ── Epic 4: Quest HUD ─────────────────────────────────────────── */}
      {!isSheetOpen && (
        <QuestHUD
          runs={activeRuns}
          selectedRunId={selectedRunId}
          onSelectRun={handleSelectRun}
        />
      )}

      {/* ── Epic 4: Quest Bottom-Sheet ────────────────────────────────── */}
      {isSheetOpen && (
        <QuestBottomSheet
          {...(selectedAvailableQuest != null ? { availableQuest: selectedAvailableQuest } : {})}
          {...(selectedRun != null ? { activeRun: selectedRun } : {})}
          playerLat={position?.lat}
          playerLng={position?.lng}
          playerAccuracy={position?.accuracy}
          onAccept={handleAcceptQuest}
          onSubmitAnswer={handleSubmitAnswer}
          onConfirmReach={handleReachLocation}
          onComplete={handleCompleteQuest}
          onDefeatEnemy={handleDefeatEnemy}
          onClose={handleCloseSheet}
        />
      )}

      {inventoryOpen && (
        <EconomySheet token={token} onClose={() => setInventoryOpen(false)} />
      )}

      {activeChallenge && !activeCombat && (
        <PvPChallengeWarning {...activeChallenge} />
      )}

      {activeCombat && (
        <CombatScreen
          combat={activeCombat}
          playerId={playerId}
          logs={logs}
          onSubmitAction={submitAction}
          reviveItemId={combatInventory.data?.items.find((item) => item.definitionId === "balm_returning" && (item.quantity ?? 0) > 0)?.id}
          onRevive={submitRevive}
        />
      )}
    </div>
  );
}
