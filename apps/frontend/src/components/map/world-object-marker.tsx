/**
 * WorldObjectMarker
 * -----------------
 * Renders a single WorldObject as a styled map marker (Marker from
 * react-map-gl/maplibre).
 *
 * Visual language:
 *   LOCATION   → amber pin      (📍)
 *   ENEMY      → red skull      (💀)
 *   NPC        → blue figure    (🗣)
 *   STORE      → yellow chest   (🏺)
 *   BOSS       → crimson dragon (🐉)
 *   SAFE_ZONE  → green shield   (🛡)
 *
 * Zone modifiers:
 *   DISCOVERED   → marker visible, subtle pulse ring
 *   INTERACTING  → bright glow ring + name label appears
 *   AGGRO        → rapid red pulse (enemies only)
 *   BOSS_JOIN    → purple bloom (boss only)
 */

import { useState } from "react";
import { Marker } from "react-map-gl/maplibre";
import type { WorldObjectNearby } from "@jlw/contracts";

// ── Config: per-type visual props ─────────────────────────────────────────────

interface TypeVisual {
  emoji: string;
  /** Tailwind bg colour for the inner dot (arbitrary value). */
  dotBg: string;
  /** Tailwind ring colour. */
  ringColour: string;
}

const TYPE_VISUALS: Record<WorldObjectNearby["type"], TypeVisual> = {
  LOCATION:  { emoji: "📍", dotBg: "bg-[#cd7f32]",  ringColour: "ring-[#cd7f32]" },
  ENEMY:     { emoji: "⚔️",  dotBg: "bg-red-500",    ringColour: "ring-red-500"   },
  NPC:       { emoji: "🗣️",  dotBg: "bg-sky-400",    ringColour: "ring-sky-400"   },
  STORE:     { emoji: "🏺",  dotBg: "bg-yellow-400", ringColour: "ring-yellow-400" },
  BOSS:      { emoji: "🐉",  dotBg: "bg-purple-500", ringColour: "ring-purple-500" },
  SAFE_ZONE: { emoji: "🛡️",  dotBg: "bg-green-400",  ringColour: "ring-green-400" },
};

// ── Zone-specific pulse animation class ──────────────────────────────────────

function pulseClass(zone: WorldObjectNearby["zone"], type: WorldObjectNearby["type"]): string {
  if (zone === "AGGRO" || (zone === "INTERACTING" && type === "ENEMY")) {
    return "animate-[ping_0.6s_ease-in-out_infinite]"; // fast pulse for danger
  }
  if (zone === "BOSS_JOIN") {
    return "animate-ping"; // standard ping for boss
  }
  if (zone === "INTERACTING") {
    return "animate-pulse";
  }
  // DISCOVERED – very subtle pulse (custom animation defined in tailwind config
  // or just use opacity/no-animation for discovered objects)
  return "";
}

// ── Pulse ring colour ─────────────────────────────────────────────────────────

function pulseColour(zone: WorldObjectNearby["zone"]): string {
  switch (zone) {
    case "INTERACTING": return "bg-white/40";
    case "AGGRO":       return "bg-red-500/50";
    case "BOSS_JOIN":   return "bg-purple-500/40";
    default:            return "bg-white/15";
  }
}

// ── Ring size per zone ────────────────────────────────────────────────────────

function ringSize(zone: WorldObjectNearby["zone"]): string {
  switch (zone) {
    case "INTERACTING":
    case "AGGRO":
    case "BOSS_JOIN":
      return "h-12 w-12";
    default:
      return "h-8 w-8"; // DISCOVERED – smaller ring
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface WorldObjectMarkerProps {
  object: WorldObjectNearby;
  onStoreInteract?: (object: WorldObjectNearby) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WorldObjectMarker({ object, onStoreInteract }: WorldObjectMarkerProps) {
  const visual = TYPE_VISUALS[object.type] ?? TYPE_VISUALS.LOCATION;
  const [expanded, setExpanded] = useState(false);

  const showLabel =
    expanded ||
    object.zone === "INTERACTING" ||
    object.zone === "AGGRO" ||
    object.zone === "BOSS_JOIN";

  return (
    <Marker
      longitude={object.lng}
      latitude={object.lat}
      anchor="center"
      // Bring closer objects to the front via z-index (effectiveDistanceM is smaller → higher z)
      style={{ zIndex: Math.round(1000 - object.effectiveDistanceM) }}
    >
      <div
        className="relative flex cursor-pointer flex-col items-center"
        onClick={() => {
          if (object.type === "STORE" && object.zone === "INTERACTING" && onStoreInteract) onStoreInteract(object);
          else setExpanded((v) => !v);
        }}
        role="button"
        aria-label={`${object.name} (${object.type})`}
      >
        {/* ── Pulse ring ─────────────────────────────────────────────── */}
        <span
          className={[
            "absolute rounded-full",
            ringSize(object.zone),
            pulseColour(object.zone),
            pulseClass(object.zone, object.type),
          ].join(" ")}
        />

        {/* ── Icon bubble ────────────────────────────────────────────── */}
        <span
          className={[
            "relative flex h-8 w-8 items-center justify-center rounded-full",
            "shadow-lg ring-2",
            visual.dotBg,
            visual.ringColour,
            "text-base leading-none select-none",
            object.zone === "INTERACTING" ? "scale-110" : "",
          ].join(" ")}
        >
          {visual.emoji}
        </span>

        {/* ── Name label (shown on tap or when player is close) ──────── */}
        {showLabel && (
          <span
            className={[
              "mt-1 max-w-[120px] truncate rounded-md px-2 py-0.5",
              "bg-black/75 text-[10px] font-semibold text-[#f4e4c1] backdrop-blur-sm",
              "whitespace-nowrap",
            ].join(" ")}
          >
            {object.name}
          </span>
        )}

        {/* ── Distance badge (shown when interacting or tapped) ─────── */}
        {showLabel && object.effectiveDistanceM > 0 && (
          <span className="mt-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] text-[#cd7f32]">
            {Math.round(object.effectiveDistanceM)} m
          </span>
        )}
      </div>
    </Marker>
  );
}
