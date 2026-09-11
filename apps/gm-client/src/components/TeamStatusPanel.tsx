/**
 * Team Status Panel Component – Epic 9
 * Shows overview of all teams' current status.
 */

import { useQuery } from "@tanstack/react-query";
import type { TeamStatus } from "@jlw/contracts";

import { API_ROOT } from "../lib/api";

export function TeamStatusPanel() {
  const { data: teams, isLoading } = useQuery<TeamStatus[]>({
    queryKey: ["gm", "team-status"],
    queryFn: async () => {
      const res = await fetch(`${API_ROOT}/gm/dashboard/team-status`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
      });
      if (!res.ok) throw new Error("Failed to fetch team status");
      return res.json();
    },
  });

  if (isLoading) {
    return <div className="text-slate-400 text-sm">Loading teams...</div>;
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Team Status</h2>
      <div className="space-y-3">
        {teams?.map((team) => (
          <div
            key={team.teamId}
            className={`p-3 rounded-lg border ${
              team.isActive
                ? "bg-slate-900/50 border-slate-700"
                : "bg-slate-900/30 border-slate-800 opacity-60"
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-bold text-sm">{team.teamName}</div>
              {!team.isActive && (
                <span className="text-xs text-slate-500">Inactive</span>
              )}
            </div>

            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">HP</span>
                <span className="font-medium">{team.hp}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Fame</span>
                <span className="font-medium text-yellow-400">{team.fame}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Denarii</span>
                <span className="font-medium text-green-400">{team.denarii}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Active Quests</span>
                <span className="font-medium">{team.activeQuestCount}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
