import { useState } from "react";
import { api } from "../lib/api.js";
import type { ClassSelectionState, RuntimeEventState } from "@jlw/contracts";

export function PreflightPage({ onGranted, onBack, onWaiting }: { onGranted: () => void; onBack: () => void; onWaiting: () => void }) {
  const [status, setStatus] = useState("Bereit für den Gerätecheck");
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      setStatus("Standortberechtigung wird geprüft…");
      if (!navigator.geolocation) throw new Error("Dieses Gerät unterstützt keinen Standortzugriff.");
      await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000 }));
      setStatus("Serverfreigabe wird angefordert…");
      const result = await api.post<ClassSelectionState>("/class-selection/preflight", {});
      if (!result.mapAccessGranted) throw new Error("Der Server hat die Karte nicht freigegeben.");
      const event = await api.get<RuntimeEventState>("/event/state");
      if (event.state === "ACTIVE") onGranted();
      else onWaiting();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Preflight fehlgeschlagen."); setRunning(false); }
  }
  return <main className="flex min-h-screen items-center justify-center bg-[#1a1a2e] px-6"><section className="w-full max-w-sm rounded-xl border border-[#cd7f32]/30 bg-[#0d0d1a] p-7 text-center"><button onClick={onBack} disabled={running} className="mb-5 w-full rounded-lg border border-[#cd7f32]/40 py-2 text-sm text-[#cd7f32] disabled:opacity-50">← Zurück zur Lobby</button><p className="text-xs tracking-[.3em] text-[#cd7f32]">TECHNISCHER PREFLIGHT</p><h1 className="mt-3 text-2xl font-bold text-[#f4e4c1]">Gerät vorbereiten</h1><ul className="mt-5 space-y-2 text-left text-sm text-[#aaa]"><li>✓ Klasse serverseitig bestätigt</li><li>• GPS und Standortfreigabe</li><li>• Verbindung zum Spielserver</li></ul><p className="mt-6 text-sm text-[#f4e4c1]">{status}</p><button disabled={running} onClick={run} className="mt-5 w-full rounded-lg bg-[#cd7f32] py-3 font-bold text-[#0d0d1a] disabled:opacity-50">{running ? "Prüfung läuft…" : "Preflight starten"}</button></section></main>;
}
