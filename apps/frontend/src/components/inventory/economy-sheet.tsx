/**
 * EconomySheet – Inventar, Ausrüstung und Team-Handel.
 */
import { useMemo, useState } from "react";
import type { ItemInstance } from "@jlw/contracts";
import {
  useAcceptTradeOffer,
  useCancelTradeOffer,
  useCreateTradeOffer,
  useEconomySummary,
  useEquipItem,
  usePlayerInventory,
  useRejectTradeOffer,
  useTeamInventory,
  useTradeOffers,
  useTradeTeams,
  useUnequipItem,
  useMoveInventoryItem,
  useConsumableItem,
} from "../../hooks/use-economy.js";

type Tab = "person" | "team" | "trade";
type ItemFilter="ALL"|"EQUIPMENT"|"CONSUMABLE"|"QUEST";

interface EconomySheetProps {
  token: string | null;
  onClose: () => void;
}

function slotLabel(slot: string): string {
  const map: Record<string, string> = {
    WEAPON: "Waffe",
    CLOTHING: "Kleidung",
    DEFENSE: "Verteidigung",
    ARTIFACT: "Artefakt",
  };
  return map[slot] ?? slot;
}

export function EconomySheet({ token, onClose }: EconomySheetProps) {
  const [tab, setTab] = useState<Tab>("person");
  const [itemFilter,setItemFilter]=useState<ItemFilter>("ALL");
  const summary = useEconomySummary(token);
  const playerInv = usePlayerInventory(token);
  const teamInv = useTeamInventory(token);
  const teams = useTradeTeams(token);
  const offers = useTradeOffers(token);
  const equip = useEquipItem();
  const unequip = useUnequipItem();
  const take = useMoveInventoryItem("take");
  const deposit = useMoveInventoryItem("deposit");
  const useItem = useConsumableItem();
  const createOffer = useCreateTradeOffer();
  const acceptOffer = useAcceptTradeOffer();
  const rejectOffer = useRejectTradeOffer();
  const cancelOffer = useCancelTradeOffer();

  const [receiverId, setReceiverId] = useState("");
  const [denariiOffer, setDenariiOffer] = useState("0");
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [counterDenarii, setCounterDenarii] = useState<Record<string, string>>({});
  const [counterItems, setCounterItems] = useState<Record<string, Record<string, number>>>({});
  const [tradeMsg, setTradeMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const s = summary.data;

  async function handleCreateOffer() {
    setTradeMsg(null);
    const items = Object.entries(selected)
      .filter(([, q]) => q > 0)
      .map(([itemInstanceId, quantity]) => ({ itemInstanceId, quantity }));
    const amount = Number.parseInt(denariiOffer, 10) || 0;
    if (!receiverId) {
      setTradeMsg({ ok: false, text: "Bitte ein Team wählen." });
      return;
    }
    if (items.length === 0 && amount <= 0) {
      setTradeMsg({ ok: false, text: "Angebot darf nicht leer sein." });
      return;
    }
    try {
      await createOffer.mutateAsync({
        counterpartyTeamId: receiverId,
        items,
        denarii: amount,
      });
      setSelected({});
      setDenariiOffer("0");
      setTradeMsg({ ok: true, text: "Angebot gesendet. Das andere Team muss die Gegenseite setzen und annehmen." });
    } catch (e) {
      setTradeMsg({
        ok: false,
        text: e instanceof Error ? e.message : "Angebot fehlgeschlagen.",
      });
    }
  }

  async function handleAccept(offerId: string) {
    setTradeMsg(null);
    const picked = counterItems[offerId] ?? {};
    const items = Object.entries(picked)
      .filter(([, q]) => q > 0)
      .map(([itemInstanceId, quantity]) => ({ itemInstanceId, quantity }));
    const denarii = Number.parseInt(counterDenarii[offerId] ?? "0", 10) || 0;
    if (items.length === 0 && denarii <= 0) {
      setTradeMsg({ ok: false, text: "Gegenseite darf nicht leer sein." });
      return;
    }
    try {
      await acceptOffer.mutateAsync({ offerId, items, denarii });
      setTradeMsg({ ok: true, text: "Tausch ausgeführt." });
    } catch (e) {
      setTradeMsg({
        ok: false,
        text: e instanceof Error ? e.message : "Annehmen fehlgeschlagen.",
      });
    }
  }

  return (
    <>
      <div
        className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="absolute bottom-0 left-0 right-0 z-40 max-h-[85vh] overflow-y-auto
                   rounded-t-3xl bg-[#1a1a2e] border-t border-[#cd7f32]/30
                   px-5 py-6 shadow-2xl"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />

        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-[#cd7f32]">
              Inventar
            </p>
            <p className="text-lg font-bold text-[#f4e4c1]">Ausrüstung & Handel</p>
          </div>
          <button
            onClick={onClose}
            className="text-xl leading-none text-white/40 hover:text-white/70"
          >
            ✕
          </button>
        </div>

        {tab!=="trade"&&<div className="mb-3 flex gap-1">{(["ALL","EQUIPMENT","CONSUMABLE","QUEST"] as const).map(filter=><button key={filter} onClick={()=>setItemFilter(filter)} className={`rounded px-2 py-1 text-[10px] ${itemFilter===filter?"bg-white/20":"text-white/50"}`}>{filter==="ALL"?"ALLE":filter==="EQUIPMENT"?"AUSRÜSTUNG":filter==="CONSUMABLE"?"CONSUMABLES":"QUEST"}</button>)}</div>}

        <div className="mb-4 flex gap-4 text-sm">
          <div className="rounded-lg border border-[#cd7f32]/30 bg-black/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-widest text-[#888]">Ruhm</p>
            <p className="font-bold text-[#cd7f32]">{s?.fame ?? "—"}</p>
          </div>
          <div className="rounded-lg border border-[#cd7f32]/30 bg-black/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-widest text-[#888]">Denare</p>
            <p className="font-bold text-[#f4e4c1]">{s?.denarii ?? "—"}</p>
          </div>
          {s && Object.keys(s.equippedStats).length > 0 && (
            <div className="rounded-lg border border-green-500/30 bg-black/30 px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-[#888]">Werte</p>
              <p className="text-xs font-semibold text-green-300">
                {Object.entries(s.equippedStats)
                  .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`)
                  .join(" · ")}
              </p>
            </div>
          )}
        </div>

        <div className="mb-4 flex gap-2">
          {(
            [
              ["person", `Person (${s?.playerCount ?? 0}/${s?.playerLimit ?? 20})`],
              ["team", `Team (${s?.teamCount ?? 0}/${s?.teamLimit ?? 40})`],
              ["trade", "Handel"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                tab === id
                  ? "bg-[#cd7f32] text-[#1a1a2e]"
                  : "bg-white/10 text-white/60"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "person" && (
          <ItemList
            items={(playerInv.data?.items ?? []).filter(item=>itemFilter==="ALL"||item.category===itemFilter)}
            loading={playerInv.isLoading}
            empty="Kein persönliches Inventar."
            canEquip
            onEquip={(id) => void equip.mutateAsync(id)}
            onUnequip={(id) => void unequip.mutateAsync(id)}
            busy={equip.isPending || unequip.isPending}
            onMove={(id,quantity) => void deposit.mutateAsync({itemInstanceId:id,quantity})}
            moveLabel="Ins Teamlager"
            onUse={(id)=>void useItem.mutateAsync({itemInstanceId:id,requestId:crypto.randomUUID()})}
          />
        )}

        {tab === "team" && (
          <ItemList
            items={(teamInv.data?.items ?? []).filter(item=>itemFilter==="ALL"||item.category===itemFilter)}
            loading={teamInv.isLoading}
            empty="Kein Team-Lager."
            onMove={(id,quantity) => void take.mutateAsync({itemInstanceId:id,quantity})}
            onTakeEquip={(id) => void take.mutateAsync({itemInstanceId:id,quantity:1,equip:true})}
            moveLabel="Nehmen"
          />
        )}

        {tab === "trade" && (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-white/50">
              Kein Geschenk: Team A bietet etwas, Team B legt die Gegenseite dazu.
              Erst bei Annehmen tauschen beide Seiten atomar.
            </p>

            {(offers.data?.incoming ?? []).length > 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-xs font-bold uppercase tracking-widest text-[#cd7f32]">
                  Eingehende Angebote
                </p>
                {offers.data!.incoming.map((offer) => (
                  <div
                    key={offer.id}
                    className="rounded-xl border border-[#cd7f32]/30 bg-black/30 p-3"
                  >
                    <p className="text-sm font-semibold text-[#f4e4c1]">
                      {offer.initiatorName} bietet
                    </p>
                    <p className="mt-1 text-xs text-white/70">
                      {(offer.initiatorPayload.itemLabels ?? []).join(", ") || "—"}
                    </p>
                    <p className="mt-3 text-[10px] uppercase tracking-widest text-[#888]">
                      Eure Gegenseite
                    </p>
                    {(teamInv.data?.items ?? []).filter(item=>!item.isBound&&!item.isEquipped&&!item.isQuestLocked&&item.category!=="QUEST").map((item) => (
                      <label
                        key={item.id}
                        className="mt-1 flex items-center justify-between text-sm text-[#f4e4c1]"
                      >
                        <span>
                          {item.name ?? item.definitionId} ×{item.quantity ?? 1}
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={item.quantity ?? 1}
                          value={counterItems[offer.id]?.[item.id] ?? 0}
                          onChange={(e) =>
                            setCounterItems((prev) => ({
                              ...prev,
                              [offer.id]: {
                                ...(prev[offer.id] ?? {}),
                                [item.id]: Number(e.target.value) || 0,
                              },
                            }))
                          }
                          className="w-16 rounded bg-black/40 px-2 py-1 text-right"
                        />
                      </label>
                    ))}
                    <label className="mt-2 block text-xs text-white/50">
                      Denare
                      <input
                        type="number"
                        min={0}
                        value={counterDenarii[offer.id] ?? "0"}
                        onChange={(e) =>
                          setCounterDenarii((prev) => ({
                            ...prev,
                            [offer.id]: e.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-[#f4e4c1]"
                      />
                    </label>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => void rejectOffer.mutateAsync(offer.id)}
                        className="flex-1 rounded-xl border border-white/20 py-2 text-xs text-white/60"
                      >
                        Ablehnen
                      </button>
                      <button
                        onClick={() => void handleAccept(offer.id)}
                        disabled={acceptOffer.isPending}
                        className="flex-1 rounded-xl bg-[#cd7f32] py-2 text-xs font-bold text-[#1a1a2e]"
                      >
                        Tausch annehmen
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(offers.data?.outgoing ?? []).length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-bold uppercase tracking-widest text-[#cd7f32]">
                  Offene eigene Angebote
                </p>
                {offers.data!.outgoing.map((offer) => (
                  <div
                    key={offer.id}
                    className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm text-[#f4e4c1]">an {offer.counterpartyName}</p>
                      <p className="text-xs text-white/50">
                        {(offer.initiatorPayload.itemLabels ?? []).join(", ")}
                      </p>
                    </div>
                    <button
                      onClick={() => void cancelOffer.mutateAsync(offer.id)}
                      className="text-xs text-red-400"
                    >
                      Zurückziehen
                    </button>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs font-bold uppercase tracking-widest text-[#cd7f32]">
              Neues Angebot
            </p>
            <select
              value={receiverId}
              onChange={(e) => setReceiverId(e.target.value)}
              className="rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-[#f4e4c1]"
            >
              <option value="">Team wählen…</option>
              {(teams.data?.teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            {(teamInv.data?.items ?? []).filter(item=>!item.isBound&&!item.isEquipped&&!item.isQuestLocked&&item.category!=="QUEST").map((item) => (
              <label
                key={item.id}
                className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
              >
                <span className="text-[#f4e4c1]">
                  {item.name ?? item.definitionId} ×{item.quantity ?? 1}
                </span>
                <input
                  type="number"
                  min={0}
                  max={item.quantity ?? 1}
                  value={selected[item.id] ?? 0}
                  onChange={(e) =>
                    setSelected((prev) => ({
                      ...prev,
                      [item.id]: Number(e.target.value) || 0,
                    }))
                  }
                  className="w-16 rounded bg-black/40 px-2 py-1 text-right text-[#f4e4c1]"
                />
              </label>
            ))}

            <label className="text-xs text-white/50">
              Denare
              <input
                type="number"
                min={0}
                value={denariiOffer}
                onChange={(e) => setDenariiOffer(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/20 bg-white/10 px-3 py-2 text-sm text-[#f4e4c1]"
              />
            </label>

            {tradeMsg && (
              <p className={tradeMsg.ok ? "text-sm text-green-400" : "text-sm text-red-400"}>
                {tradeMsg.text}
              </p>
            )}

            <button
              onClick={() => void handleCreateOffer()}
              disabled={createOffer.isPending}
              className="rounded-xl bg-[#cd7f32] py-3 text-sm font-bold text-[#1a1a2e] disabled:opacity-50"
            >
              {createOffer.isPending ? "Senden…" : "Angebot senden"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function ItemList({
  items,
  loading,
  empty,
  canEquip,
  onEquip,
  onUnequip,
  busy,
  onMove,
  onTakeEquip,
  moveLabel,
  onUse,
}: {
  items: ItemInstance[];
  loading: boolean;
  empty: string;
  canEquip?: boolean;
  onEquip?: (id: string) => void;
  onUnequip?: (id: string) => void;
  busy?: boolean;
  onMove?: (id:string,quantity:number)=>void;
  onTakeEquip?: (id:string)=>void;
  moveLabel?: string;
  onUse?: (id:string)=>void;
}) {
  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => Number(b.isEquipped) - Number(a.isEquipped)),
    [items],
  );

  if (loading) {
    return <p className="text-sm text-[#cd7f32] animate-pulse">Laden…</p>;
  }
  if (sorted.length === 0) {
    return <p className="text-sm text-white/40">{empty}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {sorted.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
        >
          <div>
            <p className="text-sm font-semibold text-[#f4e4c1]">
              {item.isEquipped ? "◆ " : ""}
              {item.name ?? item.definitionId}
              {(item.quantity ?? 1) > 1 ? ` ×${item.quantity}` : ""}
            </p>
            <p className="text-[10px] uppercase tracking-widest text-white/40">
              {item.category === "CONSUMABLE" ? "Verbrauch" : item.category === "QUEST" ? "Questitem" : slotLabel(item.slot ?? "")}
              {` · ${item.rarity}`}
              {item.stats && Object.keys(item.stats).length > 0
                ? ` · ${Object.entries(item.stats)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ")}`
                : ""}
            </p>
          </div>
          {canEquip && item.category === "EQUIPMENT" && item.canEquip && (
            <button
              disabled={busy}
              onClick={() =>
                item.isEquipped ? onUnequip?.(item.id) : onEquip?.(item.id)
              }
              className="rounded-full border border-[#cd7f32]/40 px-3 py-1 text-[11px] font-semibold text-[#cd7f32]"
            >
              {item.isEquipped ? "Ablegen" : "Anlegen"}
            </button>
          )}
          {canEquip && item.category === "EQUIPMENT" && !item.canEquip && (
            <span className="max-w-32 text-right text-[11px] font-semibold text-amber-400">
              {item.unusableReason ?? "Nicht verwendbar"}
            </span>
          )}
          {canEquip && item.category === "EQUIPMENT" && !item.isEquipped && item.canEquip && item.effectiveStats && (
            <EquipmentComparison
              oldStats={sorted.find((candidate) => candidate.isEquipped && candidate.slot === item.slot)?.effectiveStats}
              newStats={item.effectiveStats}
            />
          )}
          {onMove && !item.isEquipped && item.category !== "QUEST" && !item.isBound && <div className="ml-2 flex gap-1">
            <button onClick={()=>onMove(item.id,1)} className="rounded-full border border-white/20 px-2 py-1 text-[11px]">{moveLabel}</button>
            {onTakeEquip && item.category === "EQUIPMENT" && <button onClick={()=>onTakeEquip(item.id)} className="rounded-full bg-[#cd7f32] px-2 py-1 text-[11px] font-bold text-black">Nehmen & Anlegen</button>}
          </div>}
          {onUse && item.category==="CONSUMABLE" && <button onClick={()=>onUse(item.id)} className="ml-2 rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-bold">Verwenden</button>}
        </li>
      ))}
    </ul>
  );
}

function EquipmentComparison({ oldStats, newStats }: {
  oldStats?: Record<string, number> | undefined;
  newStats: Record<string, number>;
}) {
  return <div className="ml-3 text-right text-[10px] text-white/55" aria-label="Ausrüstungsvergleich">
    {Object.entries(newStats).map(([key, next]) => {
      const old = oldStats?.[key] ?? 0;
      const delta = next - old;
      return <div key={key}>{key}: {old} → {next} ({delta >= 0 ? "+" : ""}{delta})</div>;
    })}
  </div>;
}
