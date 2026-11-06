import React from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../src/api/client';
import { useWrite } from '../../src/api/hooks';
import { Button, Card, Empty, ErrorBox, Loading, P, Screen } from '../../src/ui/kit';
import { StaleNotice } from '../../src/ui/StaleNotice';
import { colors, space } from '../../src/theme';
import { dateTimeBR } from '../../src/util/format';
import { t } from '../../src/i18n';

interface N { id: string; type: string; partId: string | null; text: string; read: boolean; createdAt: string }

export default function Notifications() {
  const router = useRouter();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ unreadCount: number; items: N[] }>('/notifications') });
  const readAll = useWrite(() => post('/notifications/read-all'));
  const readOne = useWrite((id: string) => post(`/notifications/${id}/read`));

  return (
    <Screen scroll={false} pad={false}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, maxWidth: 720, width: '100%', alignSelf: 'center' }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={async () => { await q.refetch(); }} />}>
        <StaleNotice query={q} />
        {q.isLoading ? <Loading /> : null}
        {q.error && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
        {q.data && q.data.items.length === 0 ? <Empty text={t('notif.empty')} /> : null}
        {q.data && q.data.unreadCount > 0 ? <Button kind="secondary" small title={t('notif.markAll')} onPress={() => readAll.mutate()} /> : null}
        {q.data?.items.map((n) => (
          <Card key={n.id} style={n.read ? undefined : { borderColor: colors.primary }}
            onPress={() => { if (!n.read) readOne.mutate(n.id); if (n.partId) router.push(`/part/${n.partId}`); else if (n.type === 'DATA_UPDATE') router.push('/updates'); }}>
            <P style={n.read ? undefined : { fontWeight: '700' }}>{n.text}</P>
            <P muted small>{dateTimeBR(n.createdAt)}</P>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
