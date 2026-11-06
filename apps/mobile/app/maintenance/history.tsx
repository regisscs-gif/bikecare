import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../src/api/client';
import { Card, Empty, ErrorBox, Loading, P, Row, Screen } from '../../src/ui/kit';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { dateBR, money } from '../../src/util/format';
import { t } from '../../src/i18n';

interface Rec { id: string; date: string; shop: string | null; notes: string | null; partsCostCents: number; laborCostCents: number; items: Array<{ partId: string; part: string; services: string[]; replaced: boolean; other: string | null; km: number; hours: number }> }

export default function MaintenanceHistory() {
  const { bikeId } = useLocalSearchParams<{ bikeId: string }>();
  const q = useQuery({ queryKey: ['maintenance', bikeId], queryFn: () => get<Rec[]>(`/bikes/${bikeId}/maintenance`) });
  return (
    <Screen>
      <StaleNotice query={q} />
      {q.isLoading ? <Loading /> : null}
      {q.error && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? <Empty text={t('maint.noHistory')} /> : null}
      {q.data?.map((r) => (
        <Card key={r.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '700' }}>{dateBR(r.date)}</P>
            {r.partsCostCents + r.laborCostCents > 0 ? <P>{money(r.partsCostCents + r.laborCostCents)}</P> : null}
          </Row>
          {r.shop ? <P muted small>{r.shop}</P> : null}
          {r.items.map((i) => (
            <P key={i.partId + i.services.join()} small>
              {i.part}: {[...i.services, i.replaced ? t('maint.replaced') : null, i.other].filter(Boolean).join(', ')} · {t('maint.kmHours', { km: i.km, hours: i.hours })}
            </P>
          ))}
          {r.notes ? <P muted small>{r.notes}</P> : null}
        </Card>
      ))}
    </Screen>
  );
}
