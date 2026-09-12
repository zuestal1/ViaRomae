/**
 * Team Status Panel Component – Epic 9
 * Shows overview of all teams' current status.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamStatus } from "@jlw/contracts";

import { gmFetch } from "../lib/api";

export function TeamStatusPanel() {
  const queryClient = useQueryClient();
  const { data: teams, isLoading } = useQuery<TeamStatus[]>({
    queryKey: ["gm", "team-status"],
    queryFn: async () => {
      return gmFetch<TeamStatus[]>("/gm/dashboard/team-status");
    },
  });
  const skip = useMutation({
    mutationFn: ({ questRunId, stepId }: { questRunId: string; stepId: string }) =>
      gmFetch("/gm/commands/quest-step-skip", { method: "POST", body: JSON.stringify({ questRunId, stepId }) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["gm", "team-status"] }); },
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
              <div className="mt-3 space-y-2">
                {team.activeQuests.map((quest) => (
                  <div key={quest.questRunId} className="rounded border border-slate-700 p-2">
                    <div className="font-semibold">{quest.questTitle}</div>
                    <div className="text-slate-400">Schritt {quest.sequence}: {quest.description}</div>
                    <button type="button" className="mt-2 rounded bg-amber-700 px-2 py-1 disabled:opacity-50"
                      disabled={skip.isPending}
                      onClick={() => {
                        if (window.confirm(`„${quest.questTitle}“ – Schritt „${quest.description}“ wirklich überspringen?`))
                          skip.mutate({ questRunId: quest.questRunId, stepId: quest.stepId });
                      }}>
                      {skip.isPending && skip.variables?.questRunId === quest.questRunId ? "Wird übersprungen…" : "Aktuellen Schritt überspringen"}
                    </button>
                  </div>
                ))}
              </div>
              {skip.isSuccess && <div role="status" className="mt-2 text-green-400">Schritt erfolgreich übersprungen.</div>}
              {skip.isError && <div role="alert" className="mt-2 text-red-400">Überspringen fehlgeschlagen: {skip.error.message}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
