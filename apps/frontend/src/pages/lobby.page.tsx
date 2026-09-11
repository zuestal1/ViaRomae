/**
 * LobbyPage (Team-Lobby)
 * ----------------------
 * Shown after a successful login. Fetches the full /me profile (player + team)
 * and presents a "Zur Karte" button that transitions to the game map.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/auth.context.js";
import { api } from "../lib/api.js";
import type { MeResponse, PlayerClass } from "@jlw/contracts";

interface LobbyPageProps {
  /** Called when the player presses "Zur Karte". */
  onEnterMap: () => void;
}

// Class display names (German)
const CLASS_LABELS: Record<string, string> = {
  guard: "🛡️ Schweizer Gardist",
  cleric: "🙏 Nonne/Mönch",
  sculptor: "🗿 Bildhauer",
  condottiere: "⚔️ Condottiere",
};
const SLOT_LABELS: Record<string, string> = { WEAPON: "Waffe", CLOTHING: "Kleidung", DEFENSE: "Verteidigung", ARTIFACT: "Artefakt" };

export function LobbyPage({ onEnterMap }: LobbyPageProps) {
  const { account, setProfile, logout } = useAuth();
  const [tab, setTab] = useState<"CHARACTER" | "TEAM">("CHARACTER");

  // Fetch full profile; the token is attached automatically by api.ts
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<MeResponse>("/auth/me"),
    staleTime: 15_000,
  });

  // Enrich AuthContext with the full profile once loaded
  useEffect(() => {
    if (data) setProfile(data);
  }, [data, setProfile]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#1a1a2e]">
        <p className="text-[#cd7f32] animate-pulse">Profil wird geladen…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#1a1a2e] px-6">
        <p className="text-center text-red-400">
          Fehler beim Laden: {error instanceof Error ? error.message : "Unbekannt"}
        </p>
        <button
          onClick={logout}
          className="rounded-lg border border-red-700/40 px-4 py-2 text-sm text-red-400 hover:bg-red-900/20"
        >
          Abmelden
        </button>
      </div>
    );
  }

  const me = data!;
  const isGM = me.account.role === "GM" || me.account.role === "ADMIN";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#1a1a2e] px-6 py-10">
      {/* Title */}
      <div className="mb-8 text-center">
        <h1 className="font-serif text-3xl font-bold tracking-widest text-[#f4e4c1]">
          JLW 2026
        </h1>
        <p className="mt-1 text-xs tracking-widest text-[#cd7f32]">LOBBY</p>
      </div>

      {/* Profile Card */}
      <div className="w-full max-w-2xl rounded-xl border border-[#cd7f32]/30 bg-[#0d0d1a] p-6 shadow-2xl">
        {/* Account info */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-[#cd7f32]">
              Willkommen
            </p>
            <p className="mt-0.5 text-xl font-bold text-[#f4e4c1]">
              {me.account.username}
            </p>
          </div>
          {isGM && (
            <span className="rounded-full border border-[#cd7f32] px-3 py-1 text-xs font-semibold tracking-widest text-[#cd7f32]">
              GM
            </span>
          )}
        </div>

        <hr className="my-5 border-[#cd7f32]/20" />

        <div className="mb-5 grid grid-cols-2 rounded-lg bg-[#1a1a2e] p-1" role="tablist" aria-label="Profilansicht">
          <button role="tab" aria-selected={tab === "CHARACTER"} onClick={() => setTab("CHARACTER")} className={`rounded-md py-2 text-sm font-bold ${tab === "CHARACTER" ? "bg-[#cd7f32] text-[#0d0d1a]" : "text-[#aaa]"}`}>Charakter</button>
          <button role="tab" aria-selected={tab === "TEAM"} onClick={() => setTab("TEAM")} className={`rounded-md py-2 text-sm font-bold ${tab === "TEAM" ? "bg-[#cd7f32] text-[#0d0d1a]" : "text-[#aaa]"}`}>Team</button>
        </div>

        {me.player ? (
          <div className="space-y-3">
            {tab === "CHARACTER" ? <>
            {/* Class */}
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-[#888]">
                Klasse
              </span>
              <span className="font-semibold text-[#f4e4c1]">
                {me.player.class ? (CLASS_LABELS[me.player.class] ?? me.player.class) : "Noch nicht gewählt"}
              </span>
            </div>

            {/* HP */}
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-[#888]">
                HP
              </span>
              <span className="font-semibold text-green-400">
                {me.player.hpCurrent} / {me.player.hpMax}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              {Object.entries({ ATK: me.player.stats.atk, DEF: me.player.stats.def, INIT: me.player.stats.init }).map(([label, value]) => <div key={label} className="rounded-lg bg-[#1a1a2e] p-2"><div className="text-xs text-[#888]">{label}</div><div className="font-bold text-[#f4e4c1]">{value}</div></div>)}
            </div>
            <section><h2 className="mb-2 text-xs uppercase tracking-widest text-[#cd7f32]">Ausrüstung</h2><div className="grid grid-cols-2 gap-2">{me.player.equipment.map((item) => <div key={item.slot} className="rounded border border-[#444] p-2 text-xs"><span className="text-[#888]">{SLOT_LABELS[item.slot]}</span><p className="text-[#f4e4c1]">{item.icon} {item.name ?? "Leer"}</p></div>)}</div></section>
            <section><h2 className="mb-2 text-xs uppercase tracking-widest text-[#cd7f32]">Fähigkeiten</h2><div className="space-y-2">{me.player.abilities.map((ability) => <div key={ability.id} className="rounded bg-[#1a1a2e] p-3"><div className="font-bold text-[#f4e4c1]">⚔️ {ability.displayName} <span className="text-xs font-normal text-[#888]">{ability.passive ? "Passiv" : ability.cooldownRounds ? `Cooldown: ${ability.cooldownRounds}` : "Basisangriff"}</span></div><p className="text-xs text-[#aaa]">{ability.description}</p></div>)}</div></section>
            <section className="rounded border border-[#cd7f32]/20 p-3"><h2 className="font-bold text-[#f4e4c1]">{me.player.passive.icon} Passiv: {me.player.passive.name}</h2><p className="text-xs text-[#aaa]">{me.player.passive.description}</p></section>
            <section><h2 className="mb-2 text-xs uppercase tracking-widest text-[#cd7f32]">Aktive Statuseffekte</h2>{me.player.statusEffects.length ? me.player.statusEffects.map((effect) => <div key={effect.id} className="text-sm text-[#f4e4c1]">{effect.icon} {effect.name}: {effect.description} ({effect.remainingRounds} Runden)</div>) : <p className="text-xs text-[#888]">Keine aktiven Effekte</p>}</section>
            </> : <>

            {/* Status */}
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-[#888]">
                Status
              </span>
              <span
                className={
                  me.player.status === "ACTIVE"
                    ? "font-semibold text-green-400"
                    : "font-semibold text-red-400"
                }
              >
                {me.player.status === "ACTIVE" ? "✓ Aktiv" : "✗ Kampfunfähig"}
              </span>
            </div>

            {/* Team */}
            {me.player.team && (
              <div className="mt-4 rounded-lg border border-[#cd7f32]/20 bg-[#1a1a2e] p-3">
                <p className="text-xs uppercase tracking-widest text-[#cd7f32]">
                  Team
                </p>
                <p className="mt-1 font-bold text-[#f4e4c1]">
                  {me.player.team.name}
                </p>
                <div className="mt-2 flex justify-between text-xs">
                  <span className="text-[#888]">Ruhm</span>
                  <span className="font-semibold text-[#cd7f32]">
                    {me.player.team.fame}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-[#888]">Denare</span>
                  <span className="font-semibold text-[#f4e4c1]">
                    {me.player.team.denarii}
                  </span>
                </div>
                <div className="mt-3 space-y-2">{me.player.team.members.map((member) => <div key={member.id} className="rounded bg-[#0d0d1a] p-3"><div className="flex justify-between text-sm"><span className="font-semibold text-[#f4e4c1]">{member.name}</span><span className="text-[#cd7f32]">{CLASS_LABELS[member.class]}</span></div><div className="mt-1 text-xs text-green-400">HP {member.hpCurrent} / {member.hpMax}</div><div className="mt-1 h-1.5 overflow-hidden rounded bg-[#333]"><div className="h-full bg-green-500" style={{ width: `${Math.max(0, Math.min(100, member.hpCurrent / member.hpMax * 100))}%` }} /></div></div>)}</div>
              </div>
            )}
            </>}
          </div>
        ) : (
          <p className="text-center text-sm text-[#888]">
            Kein Spieler-Profil verknüpft.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="mt-8 flex w-full max-w-sm flex-col gap-3">
        {isGM ? <button
          onClick={() => {
            const configured = import.meta.env.VITE_GM_CLIENT_URL;
            window.location.href = configured || `${window.location.protocol}//${window.location.hostname}:5174`;
          }}
          className="w-full rounded-lg bg-[#cd7f32] py-3 font-bold text-[#0d0d1a]"
        >🛡️ &nbsp;GM-Dashboard öffnen</button> : <button
          onClick={onEnterMap}
          className="w-full rounded-lg bg-[#cd7f32] py-3 font-bold tracking-wide
                     text-[#0d0d1a] transition hover:bg-[#e8943f] active:scale-95"
        >
          🏛️ &nbsp;Klasse &amp; Preflight
        </button>}

        <button
          onClick={logout}
          className="w-full rounded-lg border border-[#444] py-2 text-sm text-[#888]
                     transition hover:border-[#cd7f32]/40 hover:text-[#cd7f32]"
        >
          Abmelden
        </button>
      </div>
    </div>
  );
}
