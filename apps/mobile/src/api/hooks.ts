import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, get } from './client';
import type { BikeDetail, Home, PartDetail, UpdateView, MaintForm } from './types';

export const useHome = () => useQuery({ queryKey: ['home'], queryFn: () => get<Home>('/home') });
export const useBikes = () => useQuery({ queryKey: ['bikes'], queryFn: () => get<any[]>('/bikes') });
export const useBike = (id: string) => useQuery({ queryKey: ['bike', id], queryFn: () => get<BikeDetail>(`/bikes/${id}`) });
export const usePart = (id: string) => useQuery({ queryKey: ['part', id], queryFn: () => get<PartDetail>(`/parts/${id}`) });
export const useUpdates = () => useQuery({ queryKey: ['updates'], queryFn: () => get<UpdateView[]>('/updates') });
export const useMaintForm = (bikeId: string) => useQuery({ queryKey: ['maintform', bikeId], queryFn: () => get<MaintForm[]>(`/bikes/${bikeId}/maintenance/form`) });

/** Qualquer escrita pode mexer em cores, avisos e contadores: invalida tudo que é derivado. */
export function useWrite<TVars = void, TRes = any>(fn: (v: TVars) => Promise<TRes>, extraKeys: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await qc.invalidateQueries();
      for (const k of extraKeys) await qc.invalidateQueries({ queryKey: k });
    },
  });
}
export { api };
