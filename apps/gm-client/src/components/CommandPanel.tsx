/**
 * Command Panel Component – Epic 9
 * GM administrative commands (HP override, currency correction, etc.).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { API_ROOT } from "../lib/api";

type CommandType = "hp_override" | "currency_correction" | "location_override" | "quest_reset";

export function CommandPanel() {
  const queryClient = useQueryClient();
  const [activeCommand, setActiveCommand] = useState<CommandType | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // HP Override
  const [hpTeamId, setHpTeamId] = useState("");
  const [hpValue, setHpValue] = useState(100);

  // Currency Correction
  const [currTeamId, setCurrTeamId] = useState("");
  const [currType, setCurrType] = useState<"FAME" | "DENARII">("FAME");
  const [currAmount, setCurrAmount] = useState(0);
  const [currReason, setCurrReason] = useState("");

  // Location Override
  const [locPlayerId, setLocPlayerId] = useState("");
  const [locLat, setLocLat] = useState(41.9028);
  const [locLng, setLocLng] = useState(12.4964);

  // Quest Reset
  const [questRunId, setQuestRunId] = useState("");

  const commandMutation = useMutation({
    mutationFn: async ({ endpoint, body }: { endpoint: string; body: any }) => {
      const res = await fetch(`${API_ROOT}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("gm_token")}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Command failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["gm"] });
      // Reset form after 3 seconds
      setTimeout(() => {
        setActiveCommand(null);
        setResult(null);
      }, 3000);
    },
  });

  const handleHPOverride = () => {
    commandMutation.mutate({
      endpoint: "/gm/commands/hp-override",
      body: { teamId: hpTeamId, newHP: hpValue },
    });
  };

  const handleCurrencyCorrection = () => {
    commandMutation.mutate({
      endpoint: "/gm/commands/currency-correction",
      body: {
        teamId: currTeamId,
        currencyType: currType,
        amount: currAmount,
        reason: currReason,
      },
    });
  };

  const handleLocationOverride = () => {
    commandMutation.mutate({
      endpoint: "/gm/commands/location-override",
      body: { playerId: locPlayerId, lat: locLat, lng: locLng },
    });
  };

  const handleQuestReset = () => {
    commandMutation.mutate({
      endpoint: "/gm/commands/quest-reset",
      body: { questRunId },
    });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">GM Commands</h2>

      {/* Command buttons */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <button
          onClick={() => setActiveCommand("hp_override")}
          className={`p-4 rounded-lg border-2 transition-colors ${
            activeCommand === "hp_override"
              ? "border-blue-500 bg-blue-900/30"
              : "border-slate-700 hover:border-slate-600"
          }`}
        >
          <div className="text-lg font-bold">💊 HP Override</div>
          <div className="text-sm text-slate-400 mt-1">Set team HP directly</div>
        </button>

        <button
          onClick={() => setActiveCommand("currency_correction")}
          className={`p-4 rounded-lg border-2 transition-colors ${
            activeCommand === "currency_correction"
              ? "border-blue-500 bg-blue-900/30"
              : "border-slate-700 hover:border-slate-600"
          }`}
        >
          <div className="text-lg font-bold">💰 Currency Correction</div>
          <div className="text-sm text-slate-400 mt-1">Add/remove FAME or Denarii</div>
        </button>

        <button
          onClick={() => setActiveCommand("location_override")}
          className={`p-4 rounded-lg border-2 transition-colors ${
            activeCommand === "location_override"
              ? "border-blue-500 bg-blue-900/30"
              : "border-slate-700 hover:border-slate-600"
          }`}
        >
          <div className="text-lg font-bold">📍 Location Override</div>
          <div className="text-sm text-slate-400 mt-1">Set player coordinates</div>
        </button>

        <button
          onClick={() => setActiveCommand("quest_reset")}
          className={`p-4 rounded-lg border-2 transition-colors ${
            activeCommand === "quest_reset"
              ? "border-blue-500 bg-blue-900/30"
              : "border-slate-700 hover:border-slate-600"
          }`}
        >
          <div className="text-lg font-bold">🔄 Quest Reset</div>
          <div className="text-sm text-slate-400 mt-1">Reset quest to ACTIVE</div>
        </button>
      </div>

      {/* Command forms */}
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        {activeCommand === "hp_override" && (
          <div className="space-y-4">
            <h3 className="text-lg font-bold">HP Override</h3>
            <input
              type="text"
              placeholder="Team ID (UUID)"
              value={hpTeamId}
              onChange={(e) => setHpTeamId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <input
              type="number"
              placeholder="New HP"
              value={hpValue}
              onChange={(e) => setHpValue(Number(e.target.value))}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <button
              onClick={handleHPOverride}
              disabled={commandMutation.isPending || !hpTeamId}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg font-medium"
            >
              {commandMutation.isPending ? "Executing..." : "Execute"}
            </button>
          </div>
        )}

        {activeCommand === "currency_correction" && (
          <div className="space-y-4">
            <h3 className="text-lg font-bold">Currency Correction</h3>
            <input
              type="text"
              placeholder="Team ID (UUID)"
              value={currTeamId}
              onChange={(e) => setCurrTeamId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <select
              value={currType}
              onChange={(e) => setCurrType(e.target.value as "FAME" | "DENARII")}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            >
              <option value="FAME">FAME</option>
              <option value="DENARII">DENARII</option>
            </select>
            <input
              type="number"
              placeholder="Amount (positive or negative)"
              value={currAmount}
              onChange={(e) => setCurrAmount(Number(e.target.value))}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <input
              type="text"
              placeholder="Reason"
              value={currReason}
              onChange={(e) => setCurrReason(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <button
              onClick={handleCurrencyCorrection}
              disabled={commandMutation.isPending || !currTeamId || !currReason}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg font-medium"
            >
              {commandMutation.isPending ? "Executing..." : "Execute"}
            </button>
          </div>
        )}

        {activeCommand === "location_override" && (
          <div className="space-y-4">
            <h3 className="text-lg font-bold">Location Override</h3>
            <input
              type="text"
              placeholder="Player ID (UUID)"
              value={locPlayerId}
              onChange={(e) => setLocPlayerId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <input
              type="number"
              step="0.000001"
              placeholder="Latitude"
              value={locLat}
              onChange={(e) => setLocLat(Number(e.target.value))}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <input
              type="number"
              step="0.000001"
              placeholder="Longitude"
              value={locLng}
              onChange={(e) => setLocLng(Number(e.target.value))}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <button
              onClick={handleLocationOverride}
              disabled={commandMutation.isPending || !locPlayerId}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg font-medium"
            >
              {commandMutation.isPending ? "Executing..." : "Execute"}
            </button>
          </div>
        )}

        {activeCommand === "quest_reset" && (
          <div className="space-y-4">
            <h3 className="text-lg font-bold">Quest Reset</h3>
            <input
              type="text"
              placeholder="Quest Run ID (UUID)"
              value={questRunId}
              onChange={(e) => setQuestRunId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg"
            />
            <button
              onClick={handleQuestReset}
              disabled={commandMutation.isPending || !questRunId}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 rounded-lg font-medium"
            >
              {commandMutation.isPending ? "Executing..." : "Execute"}
            </button>
          </div>
        )}

        {!activeCommand && (
          <div className="text-center text-slate-400 py-8">
            Select a command to execute
          </div>
        )}

        {/* Result */}
        {result && (
          <div
            className={`mt-4 p-3 rounded-lg ${
              result.success
                ? "bg-green-900/50 border border-green-700"
                : "bg-red-900/50 border border-red-700"
            }`}
          >
            {result.message}
          </div>
        )}

        {commandMutation.isError && (
          <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg">
            {(commandMutation.error as Error).message}
          </div>
        )}
      </div>
    </div>
  );
}
