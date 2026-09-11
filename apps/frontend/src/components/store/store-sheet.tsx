import { useMemo, useState } from "react";
import type { WorldObjectNearby } from "@jlw/contracts";
import { useBuyStoreItem, useSellStoreItem, useStoreCatalog, useTeamInventory } from "../../hooks/use-economy.js";

export function StoreSheet({ token, store, onClose }: {token:string|null; store:WorldObjectNearby; onClose:()=>void}) {
  const {data,isLoading,error}=useStoreCatalog(token,store.id);
  const {data:inventory}=useTeamInventory(token);
  const buy=useBuyStoreItem(store.id); const sell=useSellStoreItem(store.id);
  const [message,setMessage]=useState<string|null>(null);
  const prices=useMemo(()=>new Map(data?.items.map(item=>[item.definitionId,item.sellPrice])??[]),[data]);
  async function purchase(definitionId:string){ setMessage(null); try{const result=await buy.mutateAsync({definitionId,quantity:1,idempotencyKey:crypto.randomUUID()});setMessage(`${result.alreadyProcessed?"Bereits verbucht":"Gekauft"}: ${-result.amount} Denare.`);}catch(e){setMessage(e instanceof Error?e.message:"Kauf fehlgeschlagen.");} }
  async function sellItem(itemInstanceId:string){setMessage(null);try{const result=await sell.mutateAsync({itemInstanceId,quantity:1,idempotencyKey:crypto.randomUUID()});setMessage(`${result.alreadyProcessed?"Bereits verbucht":"Verkauft"}: +${result.amount} Denare.`);}catch(e){setMessage(e instanceof Error?e.message:"Verkauf fehlgeschlagen.");}}
  return <div className="absolute inset-0 z-40 flex items-end bg-black/55" role="dialog" aria-modal="true" aria-label={`Store ${store.name}`}>
    <section className="max-h-[82vh] w-full overflow-y-auto rounded-t-3xl border-t border-yellow-400/40 bg-[#1a1a2e] p-5 text-[#f4e4c1] shadow-2xl">
      <div className="mb-4 flex items-start justify-between"><div><p className="text-xs uppercase tracking-[.25em] text-yellow-400">Bottega</p><h2 className="text-xl font-bold">🏺 {data?.name??store.name}</h2><p className="text-sm text-yellow-200">{data?.denarii??"—"} Denare im Team</p></div><button onClick={onClose} className="rounded-full bg-white/10 px-3 py-1" aria-label="Store schließen">✕</button></div>
      {isLoading&&<p>Laden…</p>}{error&&<p className="rounded bg-red-900/50 p-3 text-red-200">{error.message}</p>}
      {data?.blockedReason&&<p className="mb-3 rounded bg-amber-900/50 p-3 text-amber-100">⚠️ {data.blockedReason}</p>}
      <h3 className="mb-2 font-bold">Sortiment</h3><div className="grid gap-2">
        {data?.items.map(item=><div key={item.definitionId} className="flex items-center justify-between rounded-xl bg-white/5 p-3"><div><p className="font-semibold">{item.name}</p><p className="text-xs text-white/55">Rückkauf: {item.sellPrice}₫</p></div><button disabled={!data.interactionAllowed||buy.isPending} onClick={()=>void purchase(item.definitionId)} className="rounded-lg bg-yellow-500 px-3 py-2 font-bold text-[#1a1a2e] disabled:opacity-40">{item.price}₫ · Kaufen</button></div>)}
      </div>
      <h3 className="mb-2 mt-5 font-bold">Team-Inventar verkaufen</h3><div className="grid gap-2">
        {(inventory?.items??[]).map(item=>{const price=prices.get(item.definitionId); const protectedItem=item.isBound||item.isEquipped||item.isQuestLocked; return <div key={item.id} className="flex items-center justify-between rounded-xl bg-white/5 p-3"><div><p>{item.name??item.definitionId} × {item.quantity??1}</p>{protectedItem&&<p className="text-xs text-red-300">Questgebunden, gebunden oder ausgerüstet</p>}</div><button disabled={!data?.interactionAllowed||sell.isPending||protectedItem||price==null} onClick={()=>void sellItem(item.id)} className="rounded-lg bg-[#cd7f32] px-3 py-2 text-sm font-bold disabled:opacity-40">{price??"—"}₫ · Verkaufen</button></div>})}
        {!inventory?.items.length&&<p className="text-sm text-white/50">Keine Team-Gegenstände vorhanden.</p>}
      </div>{message&&<p className="mt-4 rounded-lg bg-black/30 p-3 text-sm">{message}</p>}
    </section>
  </div>;
}
