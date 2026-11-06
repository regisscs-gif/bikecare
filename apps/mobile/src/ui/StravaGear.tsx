import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../api/client';
import { useWrite } from '../api/hooks';
import { Button, Card, Check, ErrorBox, Loading, P, Segmented } from './kit';
import { t, type TKey } from '../i18n';

const TYPES = ['MTB_XC', 'MTB_FULL', 'ENDURO', 'DOWNHILL', 'ROAD', 'GRAVEL', 'URBAN', 'EBIKE', 'BMX', 'TRIATHLON', 'OTHER'];

interface Gear { id: string; name: string; brand?: string | null; model?: string | null; distance?: number; primary: boolean; linkedBikeId: string | null }

/** Lista as bikes do Strava e importa as escolhidas (cria a bike já vinculada). */
export function StravaGearPicker({ onDone }: { onDone: () => void }) {
  const gear = useQuery({ queryKey: ['strava-gear'], queryFn: () => get<Gear[]>('/strava/gear') });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const run = useWrite(() => post('/strava/import', { picks: Object.entries(picked).map(([gearId, type]) => ({ gearId, type })) }));

  if (gear.isLoading) return <Loading />;
  if (gear.error) return <ErrorBox error={gear.error} onRetry={() => gear.refetch()} />;
  const list = (gear.data ?? []).filter((g) => !g.linkedBikeId);

  return (
    <View style={{ gap: 12 }}>
      <P>{t('strava.pickBikes')}</P>
      {list.map((g) => (
        <Card key={g.id}>
          <Check label={g.name} sub={[g.brand, g.model].filter(Boolean).join(' ')} checked={g.id in picked}
            onChange={(v) => setPicked((p) => { const n = { ...p }; if (v) n[g.id] = 'MTB_FULL'; else delete n[g.id]; return n; })} />
          {g.id in picked ? (
            <>
              <P muted small>{t('strava.pickType')}</P>
              <Segmented value={picked[g.id]!} onChange={(v) => setPicked((p) => ({ ...p, [g.id]: v }))} options={TYPES.map((x) => ({ value: x, label: t(`type.${x}` as TKey) }))} />
            </>
          ) : null}
        </Card>
      ))}
      {run.error ? <ErrorBox error={run.error} /> : null}
      <Button title={t('strava.import')} disabled={!Object.keys(picked).length} loading={run.isPending} onPress={() => run.mutate(undefined, { onSuccess: onDone })} />
      <Button title={t('common.skip')} kind="ghost" onPress={onDone} />
    </View>
  );
}
