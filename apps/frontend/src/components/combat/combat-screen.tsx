/**
 * Combat Screen (Epic 6)
 * Fullscreen combat UI with action buttons, HP bars, and combat log.
 */

import { useState, useEffect } from "react";
import { Shield, Zap, ArrowRight } from "lucide-react";
import type {
  CombatInstance,
  CombatLog,
  ActionType,
  Combatant,
  AbilityId,
} from "@jlw/contracts";
import { useEffect, useMemo, useState } from "react";
import { Backpack, ChevronDown, ChevronUp, Clock3 } from "lucide-react";
import type { AbilityDefinition, ActionType, Combatant, CombatInstance, CombatLog } from "@jlw/contracts";

interface CombatScreenProps {
  combat: CombatInstance;
  playerId: string;
  logs: CombatLog[];
  onSubmitAction: (actionType: ActionType, targetId?: string, details?: { abilityId: string; targetIds: string[] }) => void;
  onOpenItems?: () => void;
}

const STATE_LABELS: Record<string, string> = { INITIALIZING: "Vorbereitung", AWAITING_ACTIONS: "Aktion wählen", LOCKED: "Aktionen bestätigt", RESOLVING: "Auswertung", COMPLETED: "Beendet" };
const TARGET_LABELS: Record<string, string> = { SELF: "Selbst", ALLY: "Teammitglied", ENEMY: "Gegner", ALL_ALLIES: "Ganzes Team", ALL_ENEMIES: "Alle Gegner", ANY: "Beliebiges Ziel" };

export function CombatScreen({ combat, playerId, logs, onSubmitAction, onOpenItems }: CombatScreenProps) {
  const [abilityId, setAbilityId] = useState<string | null>(null);
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(15);
  const [showLog, setShowLog] = useState(false);
  const player = combat.combatants.find((c) => c.entityId === playerId && c.entityType === "PLAYER");
  const opponents = combat.combatants.filter((c) => c.entityType === "ENEMY" || (c.entityType === "PLAYER" && c.teamId !== player?.teamId));
  const team = combat.combatants.filter((c) => c.entityType === "PLAYER" && c.teamId === player?.teamId);
  const abilities = (player?.abilities ?? []).filter((item) => item.kind === "STANDARD" || item.kind === "CLASS").slice(0, 3);
  const selectedAbility = abilities.find((item) => item.id === abilityId) ?? null;
  const locked = combat.state !== "AWAITING_ACTIONS" || !!combat.actions.find((action) => action.actorId === player?.id && action.roundNumber === combat.roundNumber && action.isLocked);

  useEffect(() => {
    const deadline = combat.actionDeadline ? new Date(combat.actionDeadline).getTime() : Date.now() + 15_000;
    const tick = () => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick(); const timer = window.setInterval(tick, 250); return () => window.clearInterval(timer);
  }, [combat.roundNumber, combat.actionDeadline]);
  useEffect(() => { setAbilityId(null); setTargetIds([]); }, [combat.roundNumber]);

  const candidates = useMemo(() => {
    if (!selectedAbility || !player) return [];
    switch (selectedAbility.targetType) {
      case "SELF": return [player];
      case "ALLY": return team;
      case "ENEMY": return opponents;
      case "ALL_ALLIES": return team.filter((c) => !c.isDowned);
      case "ALL_ENEMIES": return opponents.filter((c) => !c.isDowned);
      default: return combat.combatants;
    }
  }, [selectedAbility, player, team, opponents, combat.combatants]);

  const reason = (ability: AbilityDefinition) => {
    if (locked) return "Die Aktion wurde vom Server bestätigt.";
    if (player?.isDowned) return "Du bist kampfunfähig.";
    if (ability.cooldownRemaining > 0) return `Noch ${ability.cooldownRemaining} Runde${ability.cooldownRemaining === 1 ? "" : "n"} Cooldown.`;
    if (ability.condition && player) {
      const hp = player.hpCurrent / player.hpMax * 100;
      if (ability.condition.type === "HP_BELOW_PERCENT" && hp >= ability.condition.value) return `HP-Bedingung nicht erfüllt: ${ability.condition.description}.`;
      if (ability.condition.type === "HP_ABOVE_PERCENT" && hp <= ability.condition.value) return `HP-Bedingung nicht erfüllt: ${ability.condition.description}.`;
    }
    if ((ability.targetType === "ALLY" || ability.targetType === "ENEMY" || ability.targetType === "ANY") && !candidates.some((c) => !c.isDowned)) return "Kein gültiges Ziel verfügbar.";
    return null;
  };
  const chooseAbility = (ability: AbilityDefinition) => {
    if (reason(ability)) return;
    setAbilityId(ability.id);
    setTargetIds(["SELF", "ALL_ALLIES", "ALL_ENEMIES"].includes(ability.targetType) ? candidates.map((c) => c.id) : []);
  };
  const submit = () => {
    if (!selectedAbility) return;
    const needsChoice = ["ALLY", "ENEMY", "ANY"].includes(selectedAbility.targetType);
    if (needsChoice && targetIds.length === 0) return;
    onSubmitAction(selectedAbility.kind === "STANDARD" ? "ATTACK" : "SKILL", targetIds[0], { abilityId: selectedAbility.id, targetIds });
  };

  const handleAbility = (abilityId: AbilityId, needsTarget: boolean) => {
    if (hasSubmittedAction || (needsTarget && !selectedTarget)) return;
    onSubmitAction(undefined, needsTarget ? selectedTarget ?? undefined : undefined, abilityId);
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
            <CombatantCard combatant={playerCombatant} isSelected={selectedTarget === playerCombatant.id} onSelect={() => setSelectedTarget(playerCombatant.id)} />
          </div>
        )}

        {/* Allies Section */}
        {allies.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-green-400">Allies</h2>
            {allies.map((ally) => (
              <CombatantCard key={ally.id} combatant={ally} isSelected={selectedTarget === ally.id} onSelect={() => setSelectedTarget(ally.id)} />
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {playerCombatant?.abilityDefinitions?.filter((ability) => !ability.passive).map((ability) => {
              const cooldown = playerCombatant.abilityCooldowns?.[ability.id] ?? 0;
              const needsTarget = !ability.allowedTargetTypes.includes("ALL_ACTIVE_ALLIES");
              return <button key={ability.id} title={ability.description}
                onClick={() => handleAbility(ability.id, needsTarget)}
                disabled={isActionDisabled || cooldown > 0 || (needsTarget && !selectedTarget)}
                className="flex flex-col items-center justify-center p-3 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:opacity-50">
                <Zap className="w-6 h-6 text-white" />
                <span className="text-xs text-white mt-1">{ability.displayName}</span>
                <span className="text-[10px] text-purple-100">{cooldown ? `Cooldown: ${cooldown}` : ability.description}</span>
              </button>;
            })}
            <button
              onClick={() => handleAction("DEFEND")}
              disabled={isActionDisabled}
              className="flex flex-col items-center justify-center p-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:opacity-50"
            >
              <Shield className="w-6 h-6 text-white" />
              <span className="text-xs text-white mt-1">Defend</span>
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
  return <div className="fixed inset-0 z-50 flex flex-col bg-gradient-to-b from-gray-950 via-red-950 to-gray-950 text-white">
    <header className="flex items-center justify-between border-b border-white/10 bg-black/50 p-4"><div><h1 className="text-xl font-bold">⚔️ Kampf</h1><p className="text-sm text-gray-300">Runde {combat.roundNumber} · {STATE_LABELS[combat.state]}</p></div><div className={`flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-xl ${seconds <= 5 ? "border-red-400 text-red-300" : "border-amber-500/50 text-amber-300"}`}><Clock3 className="h-5 w-5" /> 00:{String(seconds).padStart(2, "0")}</div></header>
    <main className="flex-1 space-y-5 overflow-y-auto p-4">
      <Group title="Gegner" color="text-red-400" entries={opponents} selected={targetIds} onSelect={(id) => selectedAbility && ["ENEMY", "ANY"].includes(selectedAbility.targetType) && setTargetIds([id])} />
      {player && <Group title="Du" color="text-blue-400" entries={[player]} selected={targetIds} onSelect={(id) => selectedAbility?.targetType === "SELF" && setTargetIds([id])} />}
      <Group title="Dein Team" color="text-green-400" entries={team.filter((c) => c.id !== player?.id)} selected={targetIds} onSelect={(id) => selectedAbility && ["ALLY", "ANY"].includes(selectedAbility.targetType) && setTargetIds([id])} />
      {logs.length > 0 && <section className="rounded-lg bg-black/50 p-3"><h2 className="mb-2 text-sm font-bold text-amber-300">Aktuelle Ereignisse</h2>{logs.slice(-3).map((log, i) => <p key={`${log.timestamp}-${i}`} className="text-sm text-gray-200">{log.message}</p>)}<button className="mt-3 flex items-center gap-1 text-xs text-gray-400" onClick={() => setShowLog(!showLog)}>{showLog ? <ChevronUp size={14}/> : <ChevronDown size={14}/>} Älteres Kampfprotokoll</button>{showLog && <div className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-white/10 pt-2">{logs.slice(0, -3).reverse().map((log, i) => <p key={`${log.timestamp}-old-${i}`} className="text-xs text-gray-400">{new Date(log.timestamp).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })} · {log.message}</p>)}</div>}</section>}
    </main>
    <footer className="border-t border-white/10 bg-black/80 p-4"><p className="mb-2 text-xs text-gray-400">Du kannst deine Auswahl bis zur Serverbestätigung ändern.</p><div className="grid grid-cols-3 gap-2">{abilities.map((ability) => { const disabledReason = reason(ability); return <button key={ability.id} onClick={() => chooseAbility(ability)} disabled={!!disabledReason} title={disabledReason ?? ability.description} className={`min-h-28 rounded-xl border p-3 text-left ${abilityId === ability.id ? "border-amber-400 bg-amber-500/20" : "border-white/10 bg-gray-800"} disabled:opacity-50`}><span className="text-2xl">{ability.icon}</span><strong className="mt-1 block text-sm">{ability.name}</strong><span className="block text-xs text-gray-300">{ability.description}</span><span className="mt-1 block text-[11px] text-amber-300">{ability.valueLabel && `${ability.value} ${ability.valueLabel} · `}{TARGET_LABELS[ability.targetType]} · CD {ability.cooldownRounds}</span>{disabledReason && <span className="mt-1 block text-[11px] font-semibold text-red-300">{disabledReason}</span>}</button>})}</div>
      {selectedAbility && <button onClick={submit} disabled={locked || (["ALLY", "ENEMY", "ANY"].includes(selectedAbility.targetType) && !targetIds.length)} className="mt-3 w-full rounded-lg bg-amber-500 py-3 font-bold text-black disabled:bg-gray-600 disabled:text-gray-300">{locked ? "Auswahl bestätigt" : targetIds.length ? "Aktion wählen / aktualisieren" : "Bitte Ziel wählen"}</button>}
      <button onClick={onOpenItems} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-600 py-2 text-sm text-gray-300"><Backpack size={17}/> Items öffnen</button>
    </footer>
  </div>;
}

function Group({ title, color, entries, selected, onSelect }: { title: string; color: string; entries: Combatant[]; selected: string[]; onSelect: (id: string) => void }) {
  if (!entries.length) return null;
  return <section className="space-y-2"><h2 className={`font-bold ${color}`}>{title}</h2>{entries.map((entry) => <CombatantCard key={entry.id} combatant={entry} selected={selected.includes(entry.id)} onSelect={() => onSelect(entry.id)} />)}</section>;
}

function CombatantCard({ combatant, selected, onSelect }: { combatant: Combatant; selected: boolean; onSelect: () => void }) {
  const hp = Math.max(0, Math.min(100, combatant.hpCurrent / combatant.hpMax * 100));
  return <button onClick={onSelect} disabled={combatant.isDowned} className={`w-full rounded-lg border-2 p-3 text-left ${selected ? "border-amber-400 bg-amber-500/10" : "border-gray-700 bg-gray-900/70"} disabled:opacity-50`}><div className="flex justify-between"><strong>{combatant.name} {combatant.class && <span className="text-xs font-normal text-gray-400">· {combatant.class}</span>}</strong><span className="text-sm">❤️ {combatant.hpCurrent}/{combatant.hpMax} · 🛡️ {combatant.shield}</span></div><div className="mt-2 h-2 overflow-hidden rounded bg-gray-700"><div className={`${hp > 50 ? "bg-green-500" : hp > 25 ? "bg-amber-500" : "bg-red-500"} h-full`} style={{ width: `${hp}%` }} /></div>{combatant.statusEffects.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{combatant.statusEffects.map((effect) => <span key={effect.id} title={effect.description} className="rounded border px-2 py-1 text-xs" style={{ color: effect.color, borderColor: effect.color }}>{effect.icon} <b>{effect.name}</b> · {effect.description} · {effect.remainingRounds} R.</span>)}</div>}</button>;
}
