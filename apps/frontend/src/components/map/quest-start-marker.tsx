/**
 * QuestStartMarker
 * ----------------
 * Shown on the map when the team has no active quest runs.
 * Represents a location where a new quest can be started.
 *
 * Visual language:
 *   REGULAR      → gold scroll    (📜)
 *   LONG_TERM    → hourglass      (⏳)
 *   HIDDEN       → mystery eye    (👁️)
 *   MEDIA        → camera         (📷)
 *
 * Always visible from a distance; subtle pulse animation to attract attention.
 * Tapping expands a label with the quest title and "quest starts here" hint.
 */

import { useState } from "react";
import { Marker } from "react-map-gl/maplibre";
import type { QuestMapLocation } from "@jlw/contracts";

// ── Per-type visuals ──────────────────────────────────────────────────────────

const QUEST_TYPE_EMOJI: Record<QuestMapLocation["type"], string> = {
  REGULAR:   "📜",
  LONG_TERM: "⏳",
  HIDDEN:    "👁️",
  MEDIA:     "📷",
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface QuestStartMarkerProps {
  location: QuestMapLocation;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QuestStartMarker({ location }: QuestStartMarkerProps) {
  const [expanded, setExpanded] = useState(false);

  // Skip markers without coordinates
  if (location.lat == null || location.lng == null) return null;

  const emoji = QUEST_TYPE_EMOJI[location.type] ?? "📜";

  return (
    <Marker
      longitude={location.lng}
      latitude={location.lat}
      anchor="bottom"
    >
      <div
        className="relative flex cursor-pointer flex-col items-center"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-label={`Quest starten: ${location.title}`}
      >
        {/* ── Outer glow ring ────────────────────────────────────────── */}
        <span className="absolute h-14 w-14 rounded-full bg-[#cd7f32]/15 animate-pulse" />

        {/* ── Inner ring ─────────────────────────────────────────────── */}
        <span className="absolute h-9 w-9 rounded-full bg-[#cd7f32]/20 ring-1 ring-[#cd7f32]/50" />

        {/* ── Icon bubble ────────────────────────────────────────────── */}
        <span
          className={[
            "relative flex h-9 w-9 items-center justify-center rounded-full",
            "bg-[#1a1a2e] ring-2 ring-[#cd7f32] shadow-[0_0_10px_2px_rgba(205,127,50,0.4)]",
            "text-lg leading-none select-none",
            "transition-transform duration-200",
            expanded ? "scale-110" : "",
          ].join(" ")}
        >
          {emoji}
        </span>

        {/* ── Stem ───────────────────────────────────────────────────── */}
        <span className="w-0.5 h-2.5 bg-[#cd7f32]/70" />

        {/* ── Dot at base ────────────────────────────────────────────── */}
        <span className="w-1.5 h-1.5 rounded-full bg-[#cd7f32] border border-white/40" />

        {/* ── Expanded label ─────────────────────────────────────────── */}
        {expanded && (
          <div className="absolute bottom-full mb-2 flex flex-col items-center">
            <div
              className={[
                "rounded-lg px-3 py-1.5 text-center shadow-xl",
                "bg-[#1a1a2e]/90 backdrop-blur-sm border border-[#cd7f32]/60",
                "max-w-[160px]",
              ].join(" ")}
            >
              <p className="text-[11px] font-bold text-[#cd7f32] leading-tight truncate">
                {location.title}
              </p>
              <p className="text-[9px] text-[#f4e4c1]/60 mt-0.5">
                📍 {location.triggerObjectName}
              </p>
              <p className="text-[9px] text-[#f4e4c1]/50 mt-0.5 italic">
                Quest hier starten
              </p>
            </div>
            {/* Arrow */}
            <span className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-[#cd7f32]/60" />
          </div>
        )}
      </div>
    </Marker>
  );
}
