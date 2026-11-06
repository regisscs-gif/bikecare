import React from 'react';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../src/api/client';
import { useAuth } from '../src/auth/AuthProvider';
import { Empty, ErrorBox, Loading, Screen } from '../src/ui/kit';
import { PartRow } from '../src/ui/PartRow';
import { t } from '../src/i18n';
import type { PartSummary } from '../src/api/types';

export default function Stock() {
  const router = useRouter();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['parts', 'STOCK'], queryFn: () => get<PartSummary[]>('/parts?status=STOCK') });
  return (
    <Screen>
      {q.isLoading ? <Loading /> : null}
      {q.error && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && q.data.length === 0 ? <Empty text={t('part.stockEmpty')} /> : null}
      {q.data?.map((p) => <PartRow key={p.id} part={p} unit={me?.distanceUnit ?? 'km'} onPress={() => router.push(`/part/${p.id}`)} />)}
    </Screen>
  );
}
