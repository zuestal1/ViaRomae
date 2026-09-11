/**
 * Economy / inventory TanStack Query hooks (Epic 5).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EconomySummary,
  EquipItemResponse,
  InventoryListResponse,
  ItemInstance,
  TeamListEntry,
  TradeOfferList,
  StoreCatalogResponse,
  StoreTransactionResponse,
} from "@jlw/contracts";
import { api } from "../lib/api.js";

export const ECONOMY_KEYS = {
  summary: ["economy", "summary"] as const,
  playerInv: ["inventory", "player"] as const,
  teamInv: ["inventory", "team"] as const,
  teams: ["economy", "teams"] as const,
  offers: ["economy", "trade-offers"] as const,
};

export function useStoreCatalog(token: string | null, storeId: string | null) {
  return useQuery({
    queryKey: ["store", storeId],
    queryFn: () => api.get<StoreCatalogResponse>(`/stores/${storeId}`),
    enabled: !!token && !!storeId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useBuyStoreItem(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { definitionId: string; quantity: number; idempotencyKey: string }) =>
      api.post<StoreTransactionResponse>(`/stores/${storeId}/buy`, input),
    onSuccess: () => { invalidateEconomy(queryClient); void queryClient.invalidateQueries({queryKey:["store",storeId]}); },
  });
}

export function useSellStoreItem(storeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { itemInstanceId: string; quantity: number; idempotencyKey: string }) =>
      api.post<StoreTransactionResponse>(`/stores/${storeId}/sell`, input),
    onSuccess: () => { invalidateEconomy(queryClient); void queryClient.invalidateQueries({queryKey:["store",storeId]}); },
  });
}

export function useEconomySummary(token: string | null) {
  return useQuery({
    queryKey: ECONOMY_KEYS.summary,
    queryFn: () => api.get<EconomySummary>("/economy/summary"),
    enabled: !!token,
    staleTime: 8_000,
    refetchInterval: 20_000,
  });
}

export function usePlayerInventory(token: string | null) {
  return useQuery({
    queryKey: ECONOMY_KEYS.playerInv,
    queryFn: () => api.get<InventoryListResponse>("/inventory?owner=player"),
    enabled: !!token,
    staleTime: 5_000,
  });
}

export function useTeamInventory(token: string | null) {
  return useQuery({
    queryKey: ECONOMY_KEYS.teamInv,
    queryFn: () => api.get<InventoryListResponse>("/inventory?owner=team"),
    enabled: !!token,
    staleTime: 5_000,
  });
}

export function useTradeTeams(token: string | null) {
  return useQuery({
    queryKey: ECONOMY_KEYS.teams,
    queryFn: () => api.get<{ teams: TeamListEntry[] }>("/economy/teams"),
    enabled: !!token,
    staleTime: 30_000,
  });
}

export function useTradeOffers(token: string | null) {
  return useQuery({
    queryKey: ECONOMY_KEYS.offers,
    queryFn: () => api.get<TradeOfferList>("/economy/trade/offers"),
    enabled: !!token,
    staleTime: 3_000,
    refetchInterval: 8_000,
  });
}

function invalidateEconomy(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["economy"] });
  void queryClient.invalidateQueries({ queryKey: ["inventory"] });
  void queryClient.invalidateQueries({ queryKey: ["me"] });
}

export function useEquipItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemInstanceId: string) =>
      api.post<EquipItemResponse>("/inventory/equip", {
        itemInstanceId,
      }),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export function useUnequipItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemInstanceId: string) =>
      api.post<{ unequipped: string }>("/inventory/unequip", { itemInstanceId }),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export function useCreateTradeOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      counterpartyTeamId: string;
      items: { itemInstanceId: string; quantity: number }[];
      denarii: number;
    }) => api.post<{ offer: unknown }>("/economy/trade/offers", body),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export function useAcceptTradeOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: {
      offerId: string;
      items: { itemInstanceId: string; quantity: number }[];
      denarii: number;
    }) =>
      api.post<{ offer: unknown }>(`/economy/trade/offers/${opts.offerId}/accept`, {
        items: opts.items,
        denarii: opts.denarii,
      }),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export function useRejectTradeOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) =>
      api.post<{ ok: boolean }>(`/economy/trade/offers/${offerId}/reject`, {}),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export function useCancelTradeOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (offerId: string) =>
      api.post<{ ok: boolean }>(`/economy/trade/offers/${offerId}/cancel`, {}),
    onSuccess: () => invalidateEconomy(queryClient),
  });
}

export type { ItemInstance };
