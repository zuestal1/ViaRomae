/**
 * Live Map Component – Epic 9
 * Shows player positions, team locations, and world objects.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Map } from "maplibre-gl";
import type { PlayerPosition, WorldObjectMarker } from "@jlw/contracts";
import "maplibre-gl/dist/maplibre-gl.css";

import { API_ROOT } from "../lib/api";

export function LiveMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);

  // Fetch player positions
  const { data: playerPositions } = useQuery<PlayerPosition[]>({
    queryKey: ["gm", "player-positions"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/dashboard/player-positions`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch player positions");
      return res.json();
    },
  });

  // Fetch world objects
  const { data: worldObjects } = useQuery<WorldObjectMarker[]>({
    queryKey: ["gm", "world-objects"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/dashboard/world-objects`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch world objects");
      return res.json();
    },
  });

  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    // Dynamic import to avoid SSR issues
    import("maplibre-gl").then((maplibregl) => {
      if (!mapContainer.current) return;

      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
        center: [12.4964, 41.9028], // Rome
        zoom: 13,
      });

      map.current.addControl(new maplibregl.NavigationControl(), "top-right");
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, []);

  // Update player markers
  useEffect(() => {
    if (!map.current || !playerPositions) return;

    // Remove old markers
    const oldMarkers = document.querySelectorAll(".player-marker");
    oldMarkers.forEach((m) => m.remove());

    // Dynamic import for markers
    import("maplibre-gl").then((maplibregl) => {
      if (!map.current || !playerPositions) return;

      playerPositions.forEach((pos) => {
        const el = document.createElement("div");
        el.className = "player-marker";
        el.style.cssText = `
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #3b82f6;
          border: 2px solid white;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          cursor: pointer;
        `;

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([pos.lng, pos.lat])
          .setPopup(
            new maplibregl.Popup({ offset: 25 }).setHTML(
              `<div style="color: #000;">
                <strong>${pos.playerName}</strong><br/>
                Team: ${pos.teamName}<br/>
                Last update: ${new Date(pos.lastUpdate).toLocaleTimeString()}
              </div>`,
            ),
          )
          .addTo(map.current!);
      });
    });
  }, [playerPositions]);

  // Update world object markers
  useEffect(() => {
    if (!map.current || !worldObjects) return;

    // Remove old world object markers
    const oldMarkers = document.querySelectorAll(".world-object-marker");
    oldMarkers.forEach((m) => m.remove());

    // Dynamic import for markers
    import("maplibre-gl").then((maplibregl) => {
      if (!map.current || !worldObjects) return;

      worldObjects.forEach((obj) => {
        const el = document.createElement("div");
        el.className = "world-object-marker";
        
        const color = obj.type === "BOSS" 
          ? "#ef4444" 
          : obj.type === "ENEMY"
          ? "#f59e0b"
          : obj.publishable
          ? "#10b981"
          : "#64748b";

        el.style.cssText = `
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: ${color};
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          cursor: pointer;
          opacity: ${obj.publishable ? 1 : 0.5};
        `;

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([obj.lng, obj.lat])
          .setPopup(
            new maplibregl.Popup({ offset: 15 }).setHTML(
              `<div style="color: #000;">
                <strong>${obj.name}</strong><br/>
                Type: ${obj.type}<br/>
                ${obj.cluster ? `Cluster: ${obj.cluster}<br/>` : ""}
                ${obj.publishable ? "✅ Published" : "⚠️ Draft"}
              </div>`,
            ),
          )
          .addTo(map.current!);
      });
    });
  }, [worldObjects]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="w-full h-full" />
      
      {/* Legend */}
      <div className="absolute top-4 left-4 bg-slate-800/95 backdrop-blur rounded-lg p-4 shadow-lg border border-slate-700">
        <h3 className="font-bold text-sm mb-2">Map Legend</h3>
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-blue-500 border-2 border-white" />
            <span>Players</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500 border-2 border-white" />
            <span>Published Objects</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500 border-2 border-white" />
            <span>Boss</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500 border-2 border-white" />
            <span>Enemy</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-slate-500 border-2 border-white opacity-50" />
            <span>Draft Objects</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="absolute bottom-4 left-4 bg-slate-800/95 backdrop-blur rounded-lg p-3 shadow-lg border border-slate-700">
        <div className="text-xs space-y-1">
          <div>👥 Players: {playerPositions?.length ?? 0}</div>
          <div>📍 Objects: {worldObjects?.length ?? 0}</div>
          <div>
            ✅ Published:{" "}
            {worldObjects?.filter((o) => o.publishable).length ?? 0}
          </div>
        </div>
      </div>
    </div>
  );
}
