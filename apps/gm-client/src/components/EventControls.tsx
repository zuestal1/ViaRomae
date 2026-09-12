/**
 * Event Controls Component – Epic 9
 * START/PAUSE/RESUME/END event controls.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EventState } from "@jlw/contracts";

import { API_ROOT } from "../lib/api";

interface StartDay2Result {
  day: 2;
  playersRestored: number;
}

export function EventControls() {
  const queryClient = useQueryClient();

  // Fetch event state
  const { data: eventState } = useQuery<EventState>({
    queryKey: ["gm", "event-state"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/event/state`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch event state");
      return res.json();
    },
  });

  // Event control mutations
  const controlMutation = useMutation({
    mutationFn: async (action: "start" | "pause" | "resume" | "end") => {
      const res = await fetch(`${API_ROOT}/gm/event/${action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || `Failed to ${action} event`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gm", "event-state"] });
    },
  });

  const startDay2Mutation = useMutation<StartDay2Result, Error>({
    mutationFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/event/day-2/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) {
        const error = await res.json().catch(() => null) as { message?: string } | null;
        throw new Error(error?.message || "Tag 2 konnte nicht gestartet werden");
      }
      return res.json();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["gm", "event-state"] }),
        queryClient.invalidateQueries({ queryKey: ["gm", "team-status"] }),
        queryClient.invalidateQueries({ queryKey: ["gm", "quests"] }),
        queryClient.invalidateQueries({ queryKey: ["gm", "world-objects"] }),
      ]);
    },
  });

  const getStateColor = (state: EventState["state"]) => {
    switch (state) {
      case "NOT_STARTED":
        return "bg-slate-700 text-slate-300";
      case "ACTIVE":
        return "bg-green-700 text-white";
      case "PAUSED":
        return "bg-yellow-700 text-white";
      case "ENDED":
        return "bg-red-700 text-white";
    }
  };

  const getStateBadge = (state: EventState["state"]) => {
    switch (state) {
      case "NOT_STARTED":
        return "⏳ Not Started";
      case "ACTIVE":
        return "▶️ Active";
      case "PAUSED":
        return "⏸️ Paused";
      case "ENDED":
        return "🏁 Ended";
    }
  };

  if (!eventState) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <div className="px-3 py-1 rounded-lg bg-slate-700 text-slate-300">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {/* State badge */}
      <div
        className={`px-3 py-1 rounded-lg font-medium text-sm ${getStateColor(
          eventState.state,
        )}`}
      >
        {getStateBadge(eventState.state)}
      </div>

      <div className="px-3 py-1 rounded-lg bg-slate-700 text-slate-200 text-sm font-medium">
        Spieltag {eventState.currentDay}
      </div>

      {/* Control buttons */}
      <div className="flex gap-2">
        {eventState.state === "NOT_STARTED" && (
          <button
            onClick={() => controlMutation.mutate("start")}
            disabled={controlMutation.isPending}
            className="px-4 py-1 bg-green-600 hover:bg-green-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            ▶️ Start Event
          </button>
        )}

        {eventState.state === "ACTIVE" && (
          <>
            <button
              onClick={() => controlMutation.mutate("pause")}
              disabled={controlMutation.isPending}
              className="px-4 py-1 bg-yellow-600 hover:bg-yellow-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              ⏸️ Pause
            </button>
            <button
              onClick={() => {
                if (
                  confirm(
                    "Are you sure you want to end the event? This will freeze the leaderboard.",
                  )
                ) {
                  controlMutation.mutate("end");
                }
              }}
              disabled={controlMutation.isPending}
              className="px-4 py-1 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              🏁 End Event
            </button>
          </>
        )}

        {eventState.state === "PAUSED" && (
          <>
            <button
              onClick={() => controlMutation.mutate("resume")}
              disabled={controlMutation.isPending}
              className="px-4 py-1 bg-green-600 hover:bg-green-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              ▶️ Resume
            </button>
            <button
              onClick={() => {
                if (
                  confirm(
                    "Are you sure you want to end the event? This will freeze the leaderboard.",
                  )
                ) {
                  controlMutation.mutate("end");
                }
              }}
              disabled={controlMutation.isPending}
              className="px-4 py-1 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              🏁 End Event
            </button>
          </>
        )}

        {(eventState.state === "ACTIVE" || eventState.state === "PAUSED") &&
          eventState.currentDay === 1 && (
            <button
              onClick={() => {
                if (
                  confirm(
                    "Tag 2 wirklich starten? Alle Spieler werden wiederhergestellt.",
                  )
                ) {
                  startDay2Mutation.reset();
                  startDay2Mutation.mutate();
                }
              }}
              disabled={startDay2Mutation.isPending}
              className="px-4 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg text-sm font-medium transition-colors"
            >
              {startDay2Mutation.isPending ? "Tag 2 wird gestartet…" : "Tag 2 starten"}
            </button>
          )}
      </div>

      {/* Error display */}
      {controlMutation.isError && (
        <div className="text-sm text-red-400">
          {(controlMutation.error as Error).message}
        </div>
      )}
      {startDay2Mutation.isSuccess && (
        <div className="text-sm text-green-400" role="status">
          Tag 2 gestartet: {startDay2Mutation.data.playersRestored} Spieler wiederhergestellt.
        </div>
      )}
      {startDay2Mutation.isError && (
        <div className="text-sm text-red-400" role="alert">
          {startDay2Mutation.error.message}
        </div>
      )}
    </div>
  );
}
