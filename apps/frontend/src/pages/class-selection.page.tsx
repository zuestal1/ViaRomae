import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cross, Hammer, Shield, Swords } from "lucide-react";
import type { ClassSelectionState, SelectablePlayerClass } from "@jlw/contracts";
import { api } from "../lib/api.js";

const CLASS_INFO = {
  guard: { name: "Schweizer Gardist", role: "Schützt das Team", hp: 120, attack: 8, defense: 14, initiative: 8, Icon: Shield },
  cleric: { name: "Nonne / Mönch", role: "Heilt und unterstützt", hp: 90, attack: 7, defense: 9, initiative: 10, Icon: Cross },
  sculptor: { name: "Bildhauer", role: "Schwächt Gegner und erkennt Details", hp: 100, attack: 11, defense: 10, initiative: 8, Icon: Hammer },
  condottiere: { name: "Condottiere", role: "Verursacht hohen Schaden", hp: 100, attack: 14, defense: 8, initiative: 12, Icon: Swords },
} satisfies Record<SelectablePlayerClass, object>;

export function ClassSelectionPage({ onConfirmed }: { onConfirmed: () => void }) {
  const client = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["class-selection"], queryFn: () => api.get<ClassSelectionState>("/class-selection/") });
  const [selected, setSelected] = useState<SelectablePlayerClass | null>(null);
  const mutation = useMutation({
    mutationFn: (value: SelectablePlayerClass) => api.post<ClassSelectionState>("/class-selection/confirm", { class: value }),
    onSuccess: (value) => { client.setQueryData(["class-selection"], value); onConfirmed(); },
  });

  if (isLoading) return <Centered text="Klassen werden geladen…" />;
  if (error || !data) return <Centered text={error instanceof Error ? error.message : "Klassen konnten nicht geladen werden."} />;
  if (data.confirmed) return <Centered text="Deine Klasse ist bereits dauerhaft bestätigt." action={onConfirmed} />;

  return (
    <main className="min-h-screen bg-[#1a1a2e] px-4 py-8 text-[#f4e4c1]">
      <div className="mx-auto max-w-2xl">
        <p className="text-center text-xs tracking-[.3em] text-[#cd7f32]">KLASSENWAHL</p>
        <h1 className="mt-2 text-center font-serif text-3xl font-bold">Wähle deine Rolle</h1>
        <p className="mx-auto mt-3 max-w-lg text-center text-sm text-[#aaa]">Jede Klasse kann pro Team nur einmal bestätigt werden. Danach bleibt sie für das gesamte Spiel gebunden.</p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          {(Object.keys(CLASS_INFO) as SelectablePlayerClass[]).map((key) => {
            const info = CLASS_INFO[key];
            const slot = data.availability.find((item) => item.class === key);
            const available = slot?.available ?? false;
            const active = selected === key;
            return <button key={key} disabled={!available || mutation.isPending} onClick={() => setSelected(key)} className={`rounded-xl border p-5 text-left transition ${active ? "border-[#e8943f] bg-[#cd7f32]/15" : "border-[#cd7f32]/25 bg-[#0d0d1a]"} disabled:cursor-not-allowed disabled:opacity-40`}>
              <div className="flex items-start justify-between"><info.Icon className="h-8 w-8 text-[#cd7f32]" /><span className={`rounded-full px-2 py-1 text-[10px] uppercase tracking-wider ${available ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>{available ? "Platz frei" : "Vergeben"}</span></div>
              <h2 className="mt-3 text-xl font-bold">{info.name}</h2><p className="text-sm text-[#aaa]">{info.role}</p>
              <div className="mt-4 grid grid-cols-4 gap-2 text-xs"><span>LP <b>{info.hp}</b></span><span>ANG <b>{info.attack}</b></span><span>VER <b>{info.defense}</b></span><span>INI <b>{info.initiative}</b></span></div>
            </button>;
          })}
        </div>
        {mutation.error && <p className="mt-4 text-center text-sm text-red-400">{mutation.error.message}</p>}
        <button disabled={!selected || mutation.isPending} onClick={() => selected && mutation.mutate(selected)} className="mt-6 w-full rounded-lg bg-[#cd7f32] py-3 font-bold text-[#0d0d1a] disabled:opacity-40">{mutation.isPending ? "Wird bestätigt…" : "Auswahl dauerhaft bestätigen"}</button>
      </div>
    </main>
  );
}

function Centered({ text, action }: { text: string; action?: () => void }) {
  return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#1a1a2e] px-6 text-center text-[#f4e4c1]"><p>{text}</p>{action && <button onClick={action} className="rounded-lg bg-[#cd7f32] px-5 py-2 font-bold text-[#0d0d1a]">Weiter</button>}</div>;
}
