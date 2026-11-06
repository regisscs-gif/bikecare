import React, { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { del, get } from '../../src/api/client';
import { useBikes, useWrite } from '../../src/api/hooks';
import { Button, Card, Empty, ErrorBox, H2, Loading, P, Row, Screen, Segmented } from '../../src/ui/kit';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { space } from '../../src/theme';
import { confirm } from '../../src/ui/dialogs';
import { dateBR, money } from '../../src/util/format';
import { t, type TKey } from '../../src/i18n';

interface Exp { id: string; bikeId: string; date: string; amountCents: number; category: string; description: string | null }
const CATS = ['PARTS', 'MAINTENANCE', 'LABOR', 'ACCESSORIES', 'TOOLS', 'TIRES', 'OTHER'];

export default function Expenses() {
  const router = useRouter();
  const bikes = useBikes();
  const [bikeId, setBikeId] = useState('');
  const [category, setCategory] = useState('');
  const qs = new URLSearchParams({ ...(bikeId ? { bikeId } : {}), ...(category ? { category } : {}) }).toString();
  const q = useQuery({ queryKey: ['expenses', bikeId, category], queryFn: () => get<{ items: Exp[]; totals: { monthCents: number; yearCents: number; filteredCents: number } }>(`/expenses?${qs}`) });
  const remove = useWrite((id: string) => del(`/expenses/${id}`));
  const bikeName = (id: string) => bikes.data?.find((b: any) => b.id === id)?.name ?? '';

  return (
    <Screen scroll={false} pad={false}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, maxWidth: 720, width: '100%', alignSelf: 'center' }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={async () => { await q.refetch(); }} />}>
        <StaleNotice query={q} />
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View><P muted small>{t('expense.month')}</P><H2>{money(q.data?.totals.monthCents ?? 0)}</H2></View>
            <View><P muted small>{t('expense.year')}</P><H2>{money(q.data?.totals.yearCents ?? 0)}</H2></View>
          </Row>
        </Card>
        <Button title={t('expense.add')} onPress={() => router.push('/expense/new')} />
        {(bikes.data?.length ?? 0) > 1 ? (
          <Segmented value={bikeId} onChange={setBikeId} options={[{ value: '', label: t('expense.all') }, ...bikes.data!.map((b: any) => ({ value: b.id, label: b.name }))]} />
        ) : null}
        <Segmented value={category} onChange={setCategory} options={[{ value: '', label: t('expense.all') }, ...CATS.map((c) => ({ value: c, label: t(`expense.${c}` as TKey) }))]} />
        {q.isLoading ? <Loading /> : null}
        {q.error && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
        {q.data && q.data.items.length === 0 ? <Empty text={t('expense.empty')} /> : null}
        {q.data?.items.map((e) => (
          <Card key={e.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <P style={{ fontWeight: '700' }}>{money(e.amountCents)}</P>
              <P muted small>{dateBR(e.date)}</P>
            </Row>
            <P>{t(`expense.${e.category}` as TKey)}{e.description ? ` · ${e.description}` : ''}</P>
            <Row style={{ justifyContent: 'space-between' }}>
              <P muted small>{bikeName(e.bikeId)}</P>
              <Button small kind="ghost" title={t('common.delete')} onPress={async () => { if (await confirm(t('common.delete'), money(e.amountCents), t('common.delete'), true)) remove.mutate(e.id); }} />
            </Row>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
