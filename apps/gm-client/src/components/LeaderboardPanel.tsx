/**
 * Leaderboard Panel Component – Epic 9
 * Shows team rankings and event summary.
 */

import { useQuery } from "@tanstack/react-query";
import type { TeamLeaderboardEntry, EventSummary } from "@jlw/contracts";

import { API_ROOT } from "../lib/api";

export function LeaderboardPanel() {
  const { data: leaderboard, isLoading: leaderboardLoading } = useQuery<
    TeamLeaderboardEntry[]
  >({
    queryKey: ["gm", "leaderboard"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/event/leaderboard`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch leaderboard");
      return res.json();
    },
  });

  const { data: summary, isLoading: summaryLoading } = useQuery<EventSummary>({
    queryKey: ["gm", "event-summary"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/event/summary`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch event summary");
      return res.json();
    },
  });

  if (leaderboardLoading || summaryLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-slate-400">Loading leaderboard...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Event Summary */}
      {summary && (
        <div className="bg-slate-800 rounded-lg p-6 mb-6 border border-slate-700">
          <h2 className="text-2xl font-bold mb-4">Event Summary</h2>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <div className="text-sm text-slate-400">Total Teams</div>
              <div className="text-3xl font-bold">{summary.totalTeams}</div>
              <div className="text-xs text-slate-500 mt-1">
                {summary.activeTeams} active
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Quests Completed</div>
              <div className="text-3xl font-bold">{summary.totalQuestsCompleted}</div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Event Duration</div>
              <div className="text-3xl font-bold">
                {Math.floor(summary.eventDurationMinutes / 60)}h{" "}
                {summary.eventDurationMinutes % 60}m
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Total Fame Awarded</div>
              <div className="text-2xl font-bold text-yellow-400">
                {summary.totalFameAwarded}
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Total Denarii Awarded</div>
              <div className="text-2xl font-bold text-green-400">
                {summary.totalDenariiAwarded}
              </div>
            </div>
            {summary.topTeam && (
              <div>
                <div className="text-sm text-slate-400">Leading Team</div>
                <div className="text-xl font-bold">{summary.topTeam.teamName}</div>
                <div className="text-xs text-slate-500">
                  {summary.topTeam.totalFame} Fame
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Leaderboard */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
        <div className="p-6 border-b border-slate-700">
          <h2 className="text-2xl font-bold">Team Leaderboard</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-900/50">
                <th className="text-left px-6 py-3 text-sm font-medium text-slate-400">
                  Rank
                </th>
                <th className="text-left px-6 py-3 text-sm font-medium text-slate-400">
                  Team
                </th>
                <th className="text-right px-6 py-3 text-sm font-medium text-slate-400">
                  Fame
                </th>
                <th className="text-right px-6 py-3 text-sm font-medium text-slate-400">
                  Denarii
                </th>
                <th className="text-right px-6 py-3 text-sm font-medium text-slate-400">
                  Quests
                </th>
              </tr>
            </thead>
            <tbody>
              {leaderboard?.map((entry) => (
                <tr
                  key={entry.teamId}
                  className="border-b border-slate-700 hover:bg-slate-900/30"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {entry.rank === 1 && <span className="text-2xl">🥇</span>}
                      {entry.rank === 2 && <span className="text-2xl">🥈</span>}
                      {entry.rank === 3 && <span className="text-2xl">🥉</span>}
                      {entry.rank > 3 && (
                        <span className="text-slate-400 font-bold">
                          #{entry.rank}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 font-bold">{entry.teamName}</td>
                  <td className="px-6 py-4 text-right font-bold text-yellow-400">
                    {entry.totalFame}
                  </td>
                  <td className="px-6 py-4 text-right font-bold text-green-400">
                    {entry.totalDenarii}
                  </td>
                  <td className="px-6 py-4 text-right text-slate-300">
                    {entry.questsCompleted}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
