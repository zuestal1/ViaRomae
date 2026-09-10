/**
 * Combat Screen (Epic 6)
 * Fullscreen combat UI with action buttons, HP bars, and combat log.
 */

import { useState, useEffect } from "react";
import { Sword, Shield, Zap, ArrowRight } from "lucide-react";
import type {
  CombatInstance,
  CombatLog,
  ActionType,
  Combatant,
} from "@jlw/contracts";

interface CombatScreenProps {
  combat: CombatInstance;
  playerId: string;
  logs: CombatLog[];
  onSubmitAction: (actionType: ActionType, targetId?: string) => void;
}

export function CombatScreen({
  combat,
  playerId,
  logs,
  onSubmitAction,
}: CombatScreenProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  // Find player's combatant
  const playerCombatant = combat.combatants.find(
    (c) => c.entityId === playerId && c.entityType === "PLAYER"
  );

  // Get enemies or opponent players
  const enemies = combat.combatants.filter((c) => {
    if (combat.type === "PVE" || combat.type === "BOSS") {
      return c.entityType === "ENEMY";
    } else {
      // PvP: opponents are players from other team
      return c.entityType === "PLAYER" && c.teamId !== playerCombatant?.teamId;
    }
  });

  // Get allies
  const allies = combat.combatants.filter(
    (c) =>
      c.entityType === "PLAYER" &&
      c.teamId === playerCombatant?.teamId &&
      c.id !== playerCombatant?.id
  );

  // Check if player has submitted action for current round
  const playerAction = combat.actions.find(
    (a) => a.actorId === playerCombatant?.id && a.roundNumber === combat.roundNumber
  );

  const hasSubmittedAction = !!playerAction;

  // Auto-select first enemy if none selected
  useEffect(() => {
    if (!selectedTarget && enemies.length > 0 && enemies[0]) {
      setSelectedTarget(enemies[0].id);
    }
  }, [selectedTarget, enemies]);

  const handleAction = (actionType: ActionType) => {
    if (hasSubmittedAction) return;
    if (actionType === "ATTACK" && !selectedTarget) return;

    onSubmitAction(actionType, selectedTarget ?? undefined);
  };

  const isActionDisabled =
    hasSubmittedAction ||
    combat.state === "LOCKED" ||
    combat.state === "RESOLVING" ||
    combat.state === "COMPLETED" ||
    playerCombatant?.isDowned;

  return (
    <div className="fixed inset-0 z-50 bg-gradient-to-b from-gray-900 via-red-900/20 to-gray-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-black/50 backdrop-blur">
        <div>
          <h1 className="text-2xl font-bold text-white">
            {combat.type === "PVE" ? "⚔️ Combat" : "⚔️ PvP Battle"}
          </h1>
          <p className="text-sm text-gray-300">
            Round {combat.roundNumber} • {combat.state}
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Enemies Section */}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-red-400">
            {combat.type === "PVE" ? "Enemies" : "Opponents"}
          </h2>
          {enemies.map((enemy) => (
            <CombatantCard
              key={enemy.id}
              combatant={enemy}
              isSelected={selectedTarget === enemy.id}
              onSelect={() => setSelectedTarget(enemy.id)}
              isEnemy
            />
          ))}
        </div>

        {/* Player Section */}
        {playerCombatant && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-blue-400">You</h2>
            <CombatantCard combatant={playerCombatant} />
          </div>
        )}

        {/* Allies Section */}
        {allies.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-green-400">Allies</h2>
            {allies.map((ally) => (
              <CombatantCard key={ally.id} combatant={ally} />
            ))}
          </div>
        )}

        {/* Combat Log */}
        {logs.length > 0 && (
          <div className="bg-black/50 backdrop-blur rounded-lg p-3 space-y-1">
            <h3 className="text-sm font-semibold text-gray-300">Combat Log</h3>
            {logs.slice(-5).map((log, i) => (
              <p
                key={i}
                className={`text-xs ${
                  log.type === "DAMAGE"
                    ? "text-red-400"
                    : log.type === "STATE"
                    ? "text-yellow-400"
                    : "text-gray-400"
                }`}
              >
                {log.message}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Action Bar */}
      <div className="bg-black/70 backdrop-blur p-4 border-t border-gray-700">
        {playerCombatant?.isDowned ? (
          <div className="text-center py-4">
            <p className="text-red-400 font-semibold">You are downed!</p>
            <p className="text-sm text-gray-400">Waiting for combat to end...</p>
          </div>
        ) : hasSubmittedAction ? (
          <div className="text-center py-4">
            <p className="text-green-400 font-semibold">Action submitted!</p>
            <p className="text-sm text-gray-400">
              Waiting for other players ({combat.state})...
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => handleAction("ATTACK")}
              disabled={isActionDisabled || !selectedTarget}
              className="flex flex-col items-center justify-center p-3 rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:opacity-50"
            >
              <Sword className="w-6 h-6 text-white" />
              <span className="text-xs text-white mt-1">Attack</span>
            </button>

            <button
              onClick={() => handleAction("DEFEND")}
              disabled={isActionDisabled}
              className="flex flex-col items-center justify-center p-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:opacity-50"
            >
              <Shield className="w-6 h-6 text-white" />
              <span className="text-xs text-white mt-1">Defend</span>
            </button>

            <button
              onClick={() => handleAction("SKILL")}
              disabled={isActionDisabled}
              className="flex flex-col items-center justify-center p-3 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:opacity-50"
            >
              <Zap className="w-6 h-6 text-white" />
              <span className="text-xs text-white mt-1">Skill</span>
            </button>

            <button
              onClick={() => handleAction("FLEE")}
              disabled={isActionDisabled || combat.type === "PVP"}
              className="flex flex-col items-center justify-center p-3 rounded-lg bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 disabled:opacity-50"
            >
              <ArrowRight className="w-6 h-6 text-white" />
              <span className="text-xs text-white mt-1">Flee</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Combatant Card Component ──────────────────────────────────────────────────

interface CombatantCardProps {
  combatant: Combatant;
  isSelected?: boolean;
  onSelect?: () => void;
  isEnemy?: boolean;
}

function CombatantCard({
  combatant,
  isSelected,
  onSelect,
  isEnemy,
}: CombatantCardProps) {
  const hpPercentage = (combatant.hpCurrent / combatant.hpMax) * 100;

  return (
    <button
      onClick={onSelect}
      disabled={!onSelect || combatant.isDowned}
      className={`w-full p-3 rounded-lg border-2 transition-all ${
        isSelected
          ? "border-yellow-500 bg-yellow-500/20"
          : "border-gray-700 bg-gray-800/50"
      } ${onSelect && !combatant.isDowned ? "hover:border-gray-500" : ""} ${
        combatant.isDowned ? "opacity-50" : ""
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          className={`font-semibold ${
            isEnemy ? "text-red-400" : "text-blue-400"
          }`}
        >
          {combatant.name}
        </span>
        <span className="text-sm text-gray-400">
          {combatant.isDowned ? "💀 Downed" : `❤️ ${combatant.hpCurrent}/${combatant.hpMax}`}
        </span>
      </div>

      {/* HP Bar */}
      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${
            hpPercentage > 50
              ? "bg-green-500"
              : hpPercentage > 25
              ? "bg-yellow-500"
              : "bg-red-500"
          }`}
          style={{ width: `${hpPercentage}%` }}
        />
      </div>
    </button>
  );
}
